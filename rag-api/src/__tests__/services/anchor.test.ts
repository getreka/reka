import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAnchorString, AnchorInput } from '../../services/anchor';

describe('buildAnchorString', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses // comment prefix for TypeScript files', () => {
    const result = buildAnchorString({
      filePath: 'src/services/foo.ts',
      language: 'typescript',
      chunkType: 'function',
    });

    expect(result).toMatch(/^\/\/ File:/);
  });

  it('uses # comment prefix for markdown files', () => {
    const result = buildAnchorString({
      filePath: 'docs/README.md',
      language: 'markdown',
      chunkType: 'document',
    });

    expect(result).toMatch(/^# File:/);
  });

  it('uses # comment prefix for YAML files', () => {
    const result = buildAnchorString({
      filePath: 'config.yaml',
      language: 'yaml',
      chunkType: 'config',
    });

    expect(result).toMatch(/^# File:/);
  });

  it('uses # comment prefix for JSON files', () => {
    const result = buildAnchorString({
      filePath: 'package.json',
      language: 'json',
      chunkType: 'config',
    });

    expect(result).toMatch(/^# File:/);
  });

  it('uses # comment prefix for RST files', () => {
    const result = buildAnchorString({
      filePath: 'docs/guide.rst',
      language: 'rst',
      chunkType: 'document',
    });

    expect(result).toMatch(/^# File:/);
  });

  it('uses # comment prefix for env files', () => {
    const result = buildAnchorString({
      filePath: '.env.example',
      language: 'env',
      chunkType: 'config',
    });

    expect(result).toMatch(/^# File:/);
  });

  it('uses // comment prefix for Python files', () => {
    const result = buildAnchorString({
      filePath: 'server.py',
      language: 'python',
      chunkType: 'function',
    });

    expect(result).toMatch(/^\/\/ File:/);
  });

  it('includes layer and service on the same line separated by |', () => {
    const result = buildAnchorString({
      filePath: 'src/services/foo.ts',
      language: 'typescript',
      chunkType: 'class',
      layer: 'service',
      service: 'FooService',
    });

    const lines = result.split('\n');
    expect(lines[1]).toBe('// Layer: service | Service: FooService');
  });

  it('includes only layer with no pipe separator when service is absent', () => {
    const result = buildAnchorString({
      filePath: 'src/services/foo.ts',
      language: 'typescript',
      chunkType: 'class',
      layer: 'service',
    });

    const lines = result.split('\n');
    expect(lines[1]).toBe('// Layer: service');
    expect(lines[1]).not.toContain('|');
  });

  it('includes only service with no pipe separator when layer is absent', () => {
    const result = buildAnchorString({
      filePath: 'src/services/foo.ts',
      language: 'typescript',
      chunkType: 'class',
      service: 'FooService',
    });

    const lines = result.split('\n');
    expect(lines[1]).toBe('// Service: FooService');
    expect(lines[1]).not.toContain('|');
  });

  it('includes Defines line with symbols joined by comma', () => {
    const result = buildAnchorString({
      filePath: 'src/utils/foo.ts',
      language: 'typescript',
      chunkType: 'function',
      symbols: ['doSomething', 'handleRequest'],
    });

    expect(result).toContain('// Defines: doSomething, handleRequest');
  });

  it('includes Imports line with imports joined by comma', () => {
    const result = buildAnchorString({
      filePath: 'src/utils/foo.ts',
      language: 'typescript',
      chunkType: 'function',
      imports: ['express', 'lodash'],
    });

    expect(result).toContain('// Imports: express, lodash');
  });

  it('truncates symbols list to first 5 when more than 5 provided', () => {
    const result = buildAnchorString({
      filePath: 'src/utils/foo.ts',
      language: 'typescript',
      chunkType: 'function',
      symbols: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });

    expect(result).toContain('// Defines: a, b, c, d, e');
    expect(result).not.toContain(', f');
  });

  it('truncates imports list to first 5 when more than 5 provided', () => {
    const result = buildAnchorString({
      filePath: 'src/utils/foo.ts',
      language: 'typescript',
      chunkType: 'function',
      imports: ['a', 'b', 'c', 'd', 'e', 'f'],
    });

    expect(result).toContain('// Imports: a, b, c, d, e');
    expect(result).not.toContain('// Imports: a, b, c, d, e, f');
  });

  it('produces only the file line for minimal required input', () => {
    const result = buildAnchorString({
      filePath: 'src/index.ts',
      language: 'typescript',
      chunkType: 'module',
    });

    const lines = result.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('// File: src/index.ts [module]');
  });

  it('produces all 4 lines for full input', () => {
    const input: AnchorInput = {
      filePath: 'src/services/foo.ts',
      language: 'typescript',
      chunkType: 'function',
      layer: 'service',
      service: 'FooService',
      symbols: ['doSomething', 'handleRequest'],
      imports: ['express', 'lodash'],
      startLine: 10,
      endLine: 50,
    };

    const result = buildAnchorString(input);
    const lines = result.split('\n');

    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('// File: src/services/foo.ts [function]');
    expect(lines[1]).toBe('// Layer: service | Service: FooService');
    expect(lines[2]).toBe('// Defines: doSomething, handleRequest');
    expect(lines[3]).toBe('// Imports: express, lodash');
  });

  it('includes filePath and chunkType in the file line', () => {
    const result = buildAnchorString({
      filePath: 'src/routes/memory.ts',
      language: 'typescript',
      chunkType: 'class',
    });

    expect(result).toContain('src/routes/memory.ts');
    expect(result).toContain('[class]');
  });
});
