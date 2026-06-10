import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ASTParser } from '../../../services/parsers/ast-parser';

describe('ASTParser', () => {
  let parser: ASTParser;

  beforeEach(() => {
    vi.resetAllMocks();
    parser = new ASTParser();
  });

  describe('canParse()', () => {
    it.each(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'])(
      'returns true for %s files',
      (ext) => {
        expect(parser.canParse(`src/file${ext}`)).toBe(true);
      }
    );

    it.each(['.md', '.json', '.yaml', '.vue', '.css', '.html'])(
      'returns false for %s files',
      (ext) => {
        expect(parser.canParse(`src/file${ext}`)).toBe(false);
      }
    );

    it('is case-insensitive for extensions', () => {
      expect(parser.canParse('src/file.TS')).toBe(true);
      expect(parser.canParse('src/file.PY')).toBe(true);
    });
  });

  describe('parse()', () => {
    it('delegates to CodeParser and returns chunks', () => {
      const content = `export function add(a: number, b: number): number {
  return a + b;
}`;
      const chunks = parser.parse(content, 'src/math.ts');

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].type).toBe('code');
      expect(chunks[0].language).toBe('typescript');
    });
  });

  describe('extractEdges() — ES import edges', () => {
    it('extracts named import edges', () => {
      const content = `import { foo, bar } from './utils';`;
      const edges = parser.extractEdges(content, 'src/main.ts');

      expect(edges.length).toBeGreaterThanOrEqual(2);
      const fooEdge = edges.find((e) => e.fromSymbol === 'foo');
      expect(fooEdge).toBeDefined();
      expect(fooEdge!.edgeType).toBe('imports');
      expect(fooEdge!.fromFile).toBe('src/main.ts');
      expect(fooEdge!.toFile).toContain('utils');
    });

    it('extracts default import edge', () => {
      const content = `import MyService from './services/my-service';`;
      const edges = parser.extractEdges(content, 'src/app.ts');

      expect(edges.length).toBeGreaterThanOrEqual(1);
      const edge = edges.find((e) => e.fromSymbol === 'MyService');
      expect(edge).toBeDefined();
      expect(edge!.edgeType).toBe('imports');
    });

    it('resolves relative import paths', () => {
      const content = `import { helper } from './lib/helper';`;
      const edges = parser.extractEdges(content, 'src/app.ts');

      const edge = edges.find((e) => e.fromSymbol === 'helper');
      expect(edge).toBeDefined();
      expect(edge!.toFile).toMatch(/lib\/helper/);
    });

    it('keeps external package import path as-is', () => {
      const content = `import express from 'express';`;
      const edges = parser.extractEdges(content, 'src/server.ts');

      const edge = edges.find((e) => e.fromSymbol === 'express');
      expect(edge).toBeDefined();
      expect(edge!.toFile).toBe('express');
    });

    it('extracts aliased import using original symbol name', () => {
      const content = `import { foo as myFoo } from './utils';`;
      const edges = parser.extractEdges(content, 'src/main.ts');

      const edge = edges.find((e) => e.fromSymbol === 'foo');
      expect(edge).toBeDefined();
      expect(edge!.toSymbol).toBe('foo');
    });

    it('extracts require() call edges', () => {
      const content = `const { helper } = require('./helper');`;
      const edges = parser.extractEdges(content, 'src/app.js');

      const edge = edges.find((e) => e.fromSymbol === 'helper');
      expect(edge).toBeDefined();
      expect(edge!.edgeType).toBe('imports');
    });

    it('extracts multiple imports from one file', () => {
      const content = `import { a } from './a';
import { b } from './b';
import { c } from './c';`;
      const edges = parser.extractEdges(content, 'src/index.ts');

      const importEdges = edges.filter((e) => e.edgeType === 'imports');
      expect(importEdges.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('extractEdges() — inheritance edges', () => {
    it('extracts extends edges from TypeScript', () => {
      const content = `class Dog extends Animal {
  bark(): void {}
}`;
      const edges = parser.extractEdges(content, 'src/dog.ts');

      const extendsEdge = edges.find((e) => e.edgeType === 'extends');
      expect(extendsEdge).toBeDefined();
      expect(extendsEdge!.fromSymbol).toBe('Dog');
      expect(extendsEdge!.toSymbol).toBe('Animal');
      expect(extendsEdge!.fromFile).toBe('src/dog.ts');
    });

    it('extracts implements edges from TypeScript', () => {
      const content = `class MyRepo implements IRepository {
  find(): void {}
}`;
      const edges = parser.extractEdges(content, 'src/repo.ts');

      const implEdge = edges.find((e) => e.edgeType === 'implements');
      expect(implEdge).toBeDefined();
      expect(implEdge!.fromSymbol).toBe('MyRepo');
      expect(implEdge!.toSymbol).toBe('IRepository');
    });

    it('extracts multiple implements interfaces', () => {
      const content = `class MyClass implements IFoo, IBar, IBaz {
  doFoo(): void {}
}`;
      const edges = parser.extractEdges(content, 'src/myclass.ts');

      const implEdges = edges.filter((e) => e.edgeType === 'implements');
      expect(implEdges.length).toBeGreaterThanOrEqual(3);
      const targets = implEdges.map((e) => e.toSymbol);
      expect(targets).toContain('IFoo');
      expect(targets).toContain('IBar');
      expect(targets).toContain('IBaz');
    });

    it('extracts both extends and implements on the same class', () => {
      const content = `class Child extends Parent implements IChild {
  run(): void {}
}`;
      const edges = parser.extractEdges(content, 'src/child.ts');

      const extendsEdge = edges.find((e) => e.edgeType === 'extends');
      const implEdge = edges.find((e) => e.edgeType === 'implements');
      expect(extendsEdge?.toSymbol).toBe('Parent');
      expect(implEdge?.toSymbol).toBe('IChild');
    });

    it('extracts Python class inheritance as extends edges', () => {
      const content = `class Dog(Animal):
    def bark(self):
        pass`;
      const edges = parser.extractEdges(content, 'src/dog.py');

      const extendsEdge = edges.find((e) => e.edgeType === 'extends');
      expect(extendsEdge).toBeDefined();
      expect(extendsEdge!.fromSymbol).toBe('Dog');
      expect(extendsEdge!.toSymbol).toBe('Animal');
    });

    it('ignores Python classes inheriting only from object', () => {
      const content = `class Foo(object):
    pass`;
      const edges = parser.extractEdges(content, 'src/foo.py');

      const extendsEdges = edges.filter((e) => e.edgeType === 'extends');
      expect(extendsEdges).toHaveLength(0);
    });

    it('extracts Java extends edges', () => {
      const content = `class Dog extends Animal {
    public void bark() {}
}`;
      const edges = parser.extractEdges(content, 'src/Dog.java');

      const extendsEdge = edges.find((e) => e.edgeType === 'extends');
      expect(extendsEdge).toBeDefined();
      expect(extendsEdge!.fromSymbol).toBe('Dog');
      expect(extendsEdge!.toSymbol).toBe('Animal');
    });

    it('extracts Java implements edges', () => {
      const content = `class MyRepo implements IRepository {
    public void find() {}
}`;
      const edges = parser.extractEdges(content, 'src/MyRepo.java');

      const implEdge = edges.find((e) => e.edgeType === 'implements');
      expect(implEdge).toBeDefined();
      expect(implEdge!.fromSymbol).toBe('MyRepo');
      expect(implEdge!.toSymbol).toBe('IRepository');
    });
  });

  describe('extractEdges() — Python import edges', () => {
    it('extracts Python from-import edges', () => {
      const content = `from os.path import join, exists`;
      const edges = parser.extractEdges(content, 'src/utils.py');

      const joinEdge = edges.find((e) => e.fromSymbol === 'join');
      expect(joinEdge).toBeDefined();
      expect(joinEdge!.edgeType).toBe('imports');
      expect(joinEdge!.toFile).toContain('os/path');
    });

    it('extracts Python direct import edges', () => {
      const content = `import os\nimport sys`;
      const edges = parser.extractEdges(content, 'src/main.py');

      const osEdge = edges.find((e) => e.fromSymbol === 'os');
      expect(osEdge).toBeDefined();
      expect(osEdge!.edgeType).toBe('imports');
    });
  });

  describe('extractEdges() — Go import edges', () => {
    it('extracts Go block import edges', () => {
      const content = `import (
    "fmt"
    "os"
)`;
      const edges = parser.extractEdges(content, 'src/main.go');

      expect(edges.length).toBeGreaterThanOrEqual(2);
      const edgeTypes = edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('imports');
    });
  });

  describe('extractEdges() — empty and error cases', () => {
    it('returns empty array for empty file', () => {
      const edges = parser.extractEdges('', 'src/empty.ts');
      expect(edges).toHaveLength(0);
    });

    it('returns empty array for file with no imports or inheritance', () => {
      const content = `const x = 1;\nconst y = 2;`;
      const edges = parser.extractEdges(content, 'src/consts.ts');
      expect(edges).toHaveLength(0);
    });

    it('returns empty array for unsupported extension', () => {
      // canParse returns false for .vue but extractEdges is called directly
      const content = `import { ref } from 'vue';`;
      const edges = parser.extractEdges(content, 'src/comp.vue');
      // .vue not in TS/JS set, so no edges extracted
      expect(edges).toHaveLength(0);
    });
  });
});
