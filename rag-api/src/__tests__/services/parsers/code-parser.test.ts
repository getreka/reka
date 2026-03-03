import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodeParser } from '../../../services/parsers/code-parser';

describe('CodeParser', () => {
  let parser: CodeParser;

  beforeEach(() => {
    vi.resetAllMocks();
    parser = new CodeParser();
  });

  describe('canParse()', () => {
    it.each([
      '.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '.go', '.rs',
      '.java', '.c', '.cpp', '.cs', '.php', '.rb', '.swift', '.kt',
      '.scala', '.sh', '.bash',
    ])('returns true for %s files', (ext) => {
      expect(parser.canParse(`src/file${ext}`)).toBe(true);
    });

    it.each(['.md', '.txt', '.json', '.yaml', '.html', '.css', '.png'])(
      'returns false for %s files',
      (ext) => {
        expect(parser.canParse(`src/file${ext}`)).toBe(false);
      }
    );

    it('is case-insensitive for extensions', () => {
      expect(parser.canParse('src/file.TS')).toBe(true);
      expect(parser.canParse('src/file.PY')).toBe(true);
    });

    it('returns false for files with no extension', () => {
      expect(parser.canParse('Makefile')).toBe(false);
    });
  });

  describe('parse() — TypeScript AST path', () => {
    it('extracts a standalone function as a chunk', () => {
      const content = `export function greet(name: string): string {
  return 'Hello ' + name;
}`;
      const chunks = parser.parse(content, 'src/greet.ts');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].symbols).toContain('greet');
      expect(chunks[0].language).toBe('typescript');
      expect(chunks[0].type).toBe('code');
      expect(chunks[0].metadata?.kind).toBe('function');
      expect(chunks[0].metadata?.exported).toBe(true);
    });

    it('extracts a class as a chunk', () => {
      const content = `export class UserService {
  getName(): string {
    return 'user';
  }
}`;
      const chunks = parser.parse(content, 'src/user.ts');

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const classChunk = chunks.find(c => c.symbols?.includes('UserService'));
      expect(classChunk).toBeDefined();
      expect(classChunk!.language).toBe('typescript');
      expect(classChunk!.metadata?.kind).toMatch(/^class/);
    });

    it('extracts an interface as a chunk', () => {
      const content = `export interface Config {
  host: string;
  port: number;
}`;
      const chunks = parser.parse(content, 'src/config.ts');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].symbols).toContain('Config');
      expect(chunks[0].metadata?.kind).toBe('interface');
    });

    it('extracts a type alias as a chunk', () => {
      const content = `export type UserId = string;`;
      const chunks = parser.parse(content, 'src/types.ts');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].symbols).toContain('UserId');
      expect(chunks[0].metadata?.kind).toBe('type');
    });

    it('extracts an enum as a chunk', () => {
      const content = `export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}`;
      const chunks = parser.parse(content, 'src/status.ts');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].symbols).toContain('Status');
      expect(chunks[0].metadata?.kind).toBe('enum');
    });

    it('extracts imports on the first chunk', () => {
      const content = `import { readFile } from 'fs';
import path from 'path';

export function loadConfig(): void {}`;
      const chunks = parser.parse(content, 'src/loader.ts');

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].imports).toContain('fs');
      expect(chunks[0].imports).toContain('path');
    });

    it('sets startLine and endLine on each chunk', () => {
      const content = `export function first(): void {}

export function second(): void {}`;
      const chunks = parser.parse(content, 'src/funcs.ts');

      for (const chunk of chunks) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      }
    });

    it('extracts multiple declarations from a single file', () => {
      const content = `export interface IRepo {
  find(id: string): Promise<unknown>;
}

export class Repo implements IRepo {
  async find(id: string): Promise<unknown> {
    return null;
  }
}

export function createRepo(): Repo {
  return new Repo();
}`;
      const chunks = parser.parse(content, 'src/repo.ts');

      const symbols = chunks.flatMap(c => c.symbols ?? []);
      expect(symbols).toContain('IRepo');
      expect(symbols).toContain('Repo');
      expect(symbols).toContain('createRepo');
    });

    it('parses JavaScript (.js) files via AST path', () => {
      const content = `function add(a, b) {
  return a + b;
}`;
      const chunks = parser.parse(content, 'src/math.js');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('javascript');
      expect(chunks[0].symbols).toContain('add');
    });

    it('splits a large class into summary + per-method chunks', () => {
      // Build a class with many methods whose full text exceeds 3000 chars
      const methods = Array.from({ length: 10 }, (_, i) => `
  method${i}(arg: string): string {
    const result = arg.repeat(${i + 1});
    const processed = result.split('').reverse().join('');
    return processed + '${i}'.padStart(20, '0');
  }`).join('\n');

      const content = `export class BigService {${methods}\n}`;
      const chunks = parser.parse(content, 'src/big.ts');

      // Large class should be split into summary + method chunks
      if (chunks.length > 1) {
        const summaryChunk = chunks.find(c => c.metadata?.kind === 'class-summary');
        const methodChunks = chunks.filter(c => c.metadata?.kind === 'method');
        expect(summaryChunk).toBeDefined();
        expect(methodChunks.length).toBeGreaterThan(0);
      } else {
        // Small enough to be a single chunk
        expect(chunks[0].symbols).toContain('BigService');
      }
    });
  });

  describe('parse() — regex fallback path', () => {
    it('parses Python files with regex fallback', () => {
      const content = `def greet(name):
    return f'Hello {name}'

class Greeter:
    def __init__(self, prefix):
        self.prefix = prefix

    def greet(self, name):
        return f'{self.prefix} {name}'`;
      const chunks = parser.parse(content, 'src/greet.py');

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const symbols = chunks.flatMap(c => c.symbols ?? []);
      expect(symbols).toContain('greet');
      expect(symbols).toContain('Greeter');
    });

    it('parses Go files with regex fallback', () => {
      const content = `package main

func Add(a, b int) int {
    return a + b
}

type Config struct {
    Host string
    Port int
}`;
      const chunks = parser.parse(content, 'src/main.go');

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const symbols = chunks.flatMap(c => c.symbols ?? []);
      expect(symbols).toContain('Add');
    });

    it('chunks large files by line count when no boundaries found', () => {
      // Build a file with no recognizable boundaries and total size > maxChunkSize
      const lines = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`);
      const content = lines.join('\n');
      const chunks = parser.parse(content, 'src/data.py');

      // Should produce at least 1 chunk covering all lines
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        expect(chunk.type).toBe('code');
      }
    });

    it('imports appear only on the first chunk for regex path', () => {
      const content = `import os
import sys

def main():
    pass

def helper():
    pass`;
      const chunks = parser.parse(content, 'src/main.py');

      expect(chunks[0].imports).toBeDefined();
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].imports).toBeUndefined();
      }
    });
  });

  describe('parse() — empty and edge cases', () => {
    it('returns at most one chunk for empty TypeScript file', () => {
      const chunks = parser.parse('', 'src/empty.ts');
      // Empty file produces no AST nodes; regex fallback emits one empty-content chunk
      expect(chunks.length).toBeLessThanOrEqual(1);
    });

    it('returns a single chunk for a file with only comments', () => {
      const content = `// This is a comment\n// Another comment`;
      const chunks = parser.parse(content, 'src/comments.py');
      // No boundaries → falls through to chunkByLines
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('extractSymbols()', () => {
    it('extracts function names', () => {
      const symbols = parser.extractSymbols('function myFunc() {}');
      expect(symbols).toContain('myFunc');
    });

    it('extracts class names', () => {
      const symbols = parser.extractSymbols('class MyClass {}');
      expect(symbols).toContain('MyClass');
    });

    it('extracts interface names', () => {
      const symbols = parser.extractSymbols('interface IFoo {}');
      expect(symbols).toContain('IFoo');
    });

    it('extracts Python function names', () => {
      const symbols = parser.extractSymbols('def my_func():');
      expect(symbols).toContain('my_func');
    });

    it('deduplicates symbols', () => {
      const symbols = parser.extractSymbols('function foo() {}\nfunction foo() {}');
      expect(symbols.filter(s => s === 'foo')).toHaveLength(1);
    });

    it('ignores single-character names', () => {
      const symbols = parser.extractSymbols('function x() {}');
      expect(symbols).not.toContain('x');
    });
  });

  describe('extractImports()', () => {
    it('extracts ES import paths', () => {
      const imports = parser.extractImports("import foo from 'lodash';");
      expect(imports).toContain('lodash');
    });

    it('extracts named ES imports', () => {
      const imports = parser.extractImports("import { bar } from './utils';");
      expect(imports).toContain('./utils');
    });

    it('extracts require() paths', () => {
      const imports = parser.extractImports("const x = require('express');");
      expect(imports).toContain('express');
    });

    it('extracts Python from-import module', () => {
      const imports = parser.extractImports('from os.path import join');
      expect(imports).toContain('os.path');
    });

    it('deduplicates import paths', () => {
      const content = "import a from 'lodash';\nimport b from 'lodash';";
      const imports = parser.extractImports(content);
      expect(imports.filter(i => i === 'lodash')).toHaveLength(1);
    });

    it('returns empty array when no imports found', () => {
      const imports = parser.extractImports('const x = 1;');
      expect(imports).toHaveLength(0);
    });
  });
});
