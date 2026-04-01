import { describe, it, expect } from 'vitest';
import {
  searchSchema,
  askSchema,
  createMemorySchema,
  recallMemorySchema,
  listMemorySchema,
  projectNameSchema,
  limitSchema,
  searchHybridSchema,
  mergeMemoriesSchema,
  indexSchema,
  maintenanceSchema,
  forgetOlderThanSchema,
} from '../../utils/validation';

describe('projectNameSchema', () => {
  it('accepts valid names', () => {
    expect(projectNameSchema.parse('my-project')).toBe('my-project');
    expect(projectNameSchema.parse('proj_123')).toBe('proj_123');
    expect(projectNameSchema.parse('A')).toBe('A');
  });

  it('rejects empty string', () => {
    expect(() => projectNameSchema.parse('')).toThrow();
  });

  it('rejects special characters', () => {
    expect(() => projectNameSchema.parse('my project')).toThrow();
    expect(() => projectNameSchema.parse('proj@name')).toThrow();
  });

  it('rejects names over 50 chars', () => {
    expect(() => projectNameSchema.parse('a'.repeat(51))).toThrow();
  });
});

describe('limitSchema', () => {
  it('defaults to 5', () => {
    expect(limitSchema.parse(undefined)).toBe(5);
  });

  it('accepts valid numbers', () => {
    expect(limitSchema.parse(1)).toBe(1);
    expect(limitSchema.parse(100)).toBe(100);
  });

  it('rejects 0 and > 100', () => {
    expect(() => limitSchema.parse(0)).toThrow();
    expect(() => limitSchema.parse(101)).toThrow();
  });

  it('rejects floats', () => {
    expect(() => limitSchema.parse(1.5)).toThrow();
  });
});

describe('searchSchema', () => {
  it('validates valid search input', () => {
    const result = searchSchema.parse({
      collection: 'test_codebase',
      query: 'embedding service',
    });
    expect(result.collection).toBe('test_codebase');
    expect(result.query).toBe('embedding service');
  });

  it('rejects missing collection', () => {
    expect(() => searchSchema.parse({ query: 'test' })).toThrow();
  });

  it('rejects empty query', () => {
    expect(() => searchSchema.parse({ collection: 'c', query: '' })).toThrow();
  });

  it('accepts optional filters', () => {
    const result = searchSchema.parse({
      collection: 'c',
      query: 'q',
      filters: { language: 'typescript', path: 'src/' },
    });
    expect(result.filters?.language).toBe('typescript');
  });
});

describe('askSchema', () => {
  it('validates valid input', () => {
    const result = askSchema.parse({
      collection: 'test_codebase',
      question: 'How does the API work?',
    });
    expect(result.question).toBe('How does the API work?');
  });

  it('rejects question over 5000 chars', () => {
    expect(() => askSchema.parse({ collection: 'c', question: 'x'.repeat(5001) })).toThrow();
  });
});

describe('createMemorySchema', () => {
  it('validates with defaults', () => {
    const result = createMemorySchema.parse({
      content: 'Remember this',
    });
    expect(result.type).toBe('note');
    expect(result.content).toBe('Remember this');
  });

  it('accepts all memory types', () => {
    for (const type of ['decision', 'insight', 'context', 'todo', 'conversation', 'note']) {
      const result = createMemorySchema.parse({ content: 'x', type });
      expect(result.type).toBe(type);
    }
  });

  it('rejects invalid memory type', () => {
    expect(() => createMemorySchema.parse({ content: 'x', type: 'invalid' })).toThrow();
  });

  it('rejects empty content', () => {
    expect(() => createMemorySchema.parse({ content: '' })).toThrow();
  });

  it('accepts tags', () => {
    const result = createMemorySchema.parse({
      content: 'x',
      tags: ['api', 'design'],
    });
    expect(result.tags).toEqual(['api', 'design']);
  });

  it('rejects more than 20 tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(() => createMemorySchema.parse({ content: 'x', tags })).toThrow();
  });
});

describe('recallMemorySchema', () => {
  it('validates with defaults', () => {
    const result = recallMemorySchema.parse({ query: 'find stuff' });
    expect(result.type).toBe('all');
  });

  it('accepts specific type', () => {
    const result = recallMemorySchema.parse({ query: 'q', type: 'decision' });
    expect(result.type).toBe('decision');
  });

  it('accepts "all" type', () => {
    const result = recallMemorySchema.parse({ query: 'q', type: 'all' });
    expect(result.type).toBe('all');
  });
});

describe('listMemorySchema', () => {
  it('defaults limit to 10', () => {
    const result = listMemorySchema.parse({});
    expect(result.limit).toBe(10);
  });

  it('accepts tag filter', () => {
    const result = listMemorySchema.parse({ tag: 'api' });
    expect(result.tag).toBe('api');
  });
});

describe('searchHybridSchema', () => {
  it('defaults semanticWeight to 0.7', () => {
    const result = searchHybridSchema.parse({
      collection: 'c',
      query: 'q',
    });
    expect(result.semanticWeight).toBe(0.7);
  });

  it('rejects semanticWeight outside 0-1', () => {
    expect(() =>
      searchHybridSchema.parse({ collection: 'c', query: 'q', semanticWeight: 1.5 })
    ).toThrow();
  });
});

describe('mergeMemoriesSchema', () => {
  it('defaults dryRun to true', () => {
    const result = mergeMemoriesSchema.parse({});
    expect(result.dryRun).toBe(true);
  });

  it('defaults threshold to 0.9', () => {
    const result = mergeMemoriesSchema.parse({});
    expect(result.threshold).toBe(0.9);
  });

  it('rejects threshold below 0.5', () => {
    expect(() => mergeMemoriesSchema.parse({ threshold: 0.3 })).toThrow();
  });
});

describe('indexSchema', () => {
  it('defaults force to false', () => {
    const result = indexSchema.parse({});
    expect(result.force).toBe(false);
  });

  it('accepts patterns array', () => {
    const result = indexSchema.parse({ patterns: ['**/*.ts'] });
    expect(result.patterns).toEqual(['**/*.ts']);
  });
});

describe('maintenanceSchema', () => {
  it('accepts empty body (all optional)', () => {
    const result = maintenanceSchema.parse({});
    expect(result.operations).toBeUndefined();
  });

  it('applies defaults when operations object is provided empty', () => {
    const result = maintenanceSchema.parse({ operations: {} });
    expect(result.operations!.quarantine_cleanup).toBe(true);
    expect(result.operations!.feedback_maintenance).toBe(true);
    expect(result.operations!.compaction).toBe(false);
    expect(result.operations!.compaction_dry_run).toBe(true);
  });

  it('respects explicit overrides', () => {
    const result = maintenanceSchema.parse({
      operations: { quarantine_cleanup: false, compaction: true, compaction_dry_run: false },
    });
    expect(result.operations!.quarantine_cleanup).toBe(false);
    expect(result.operations!.compaction).toBe(true);
    expect(result.operations!.compaction_dry_run).toBe(false);
  });

  it('validates projectName format', () => {
    expect(() => maintenanceSchema.parse({ projectName: 'INVALID NAME!' })).toThrow();
  });
});

describe('forgetOlderThanSchema', () => {
  it('accepts valid olderThanDays', () => {
    const result = forgetOlderThanSchema.parse({ olderThanDays: 30 });
    expect(result.olderThanDays).toBe(30);
  });

  it('rejects olderThanDays < 1', () => {
    expect(() => forgetOlderThanSchema.parse({ olderThanDays: 0 })).toThrow();
  });

  it('rejects olderThanDays > 365', () => {
    expect(() => forgetOlderThanSchema.parse({ olderThanDays: 500 })).toThrow();
  });

  it('rejects non-integer', () => {
    expect(() => forgetOlderThanSchema.parse({ olderThanDays: 30.5 })).toThrow();
  });

  it('requires olderThanDays', () => {
    expect(() => forgetOlderThanSchema.parse({})).toThrow();
  });
});
