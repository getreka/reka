import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  embedFull: vi.fn(),
  search: vi.fn(),
  searchHybridNative: vi.fn(),
  complete: vi.fn(),
  recall: vi.fn(),
  expand: vi.fn(),
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: { embed: mocks.embed, embedFull: mocks.embedFull },
  SparseVector: {},
}));
vi.mock('../../services/vector-store', () => ({
  vectorStore: { search: mocks.search, searchHybridNative: mocks.searchHybridNative },
  SearchResult: {},
}));
vi.mock('../../services/llm', () => ({ llm: { complete: mocks.complete } }));
vi.mock('../../services/memory', () => ({ memoryService: { recall: mocks.recall } }));
vi.mock('../../services/graph-store', () => ({ graphStore: { expand: mocks.expand } }));
vi.mock('../../utils/metrics', () => ({
  contextPackDuration: { observe: vi.fn() },
  contextPackTokens: { observe: vi.fn() },
  rerankDuration: { observe: vi.fn() },
}));

import { contextPackBuilder } from '../../services/context-pack';

function setDefaults() {
  mocks.embed.mockResolvedValue(Array(1024).fill(0));
  mocks.search.mockResolvedValue([]);
  mocks.recall.mockResolvedValue([]);
  mocks.expand.mockResolvedValue([]);
}

describe('ContextPackBuilder', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setDefaults();
  });

  it('returns assembled context for basic query', async () => {
    mocks.search.mockResolvedValue([
      {
        id: '1',
        score: 0.9,
        payload: { file: 'auth.ts', content: 'export class Auth {}', language: 'typescript' },
      },
    ]);

    const pack = await contextPackBuilder.build({
      projectName: 'test',
      query: 'authentication',
      maxTokens: 8000,
    });

    expect(pack.assembled).toContain('auth.ts');
    expect(pack.totalTokens).toBeGreaterThan(0);
    expect(pack.facets.length).toBeGreaterThanOrEqual(1);
  });

  it('includes docs facet for documentation queries', async () => {
    mocks.search.mockResolvedValue([]);

    const pack = await contextPackBuilder.build({
      projectName: 'test',
      query: 'how to configure the documentation system',
      maxTokens: 4000,
    });

    // Should have attempted search on docs collection
    const searchCalls = mocks.search.mock.calls;
    const collections = searchCalls.map((c) => c[0]);
    expect(collections).toContain('test_docs');
  });

  it('includes contracts facet for API queries', async () => {
    mocks.search.mockResolvedValue([]);

    await contextPackBuilder.build({
      projectName: 'test',
      query: 'API endpoint schema definition',
      maxTokens: 4000,
    });

    const collections = mocks.search.mock.calls.map((c) => c[0]);
    expect(collections).toContain('test_contracts');
  });

  it('calls graph expansion when graphExpand is true', async () => {
    mocks.search.mockResolvedValue([
      { id: '1', score: 0.9, payload: { file: 'a.ts', content: 'code', language: 'ts' } },
    ]);
    mocks.expand.mockResolvedValue(['a.ts', 'b.ts']);

    await contextPackBuilder.build({
      projectName: 'test',
      query: 'auth',
      maxTokens: 8000,
      graphExpand: true,
    });

    expect(mocks.expand).toHaveBeenCalled();
  });

  it('includes ADRs in guardrails when requested', async () => {
    mocks.search.mockResolvedValue([]);
    mocks.recall.mockResolvedValue([
      { memory: { content: 'Use JWT for auth', type: 'decision' }, score: 0.7 },
    ]);

    const pack = await contextPackBuilder.build({
      projectName: 'test',
      query: 'authentication',
      maxTokens: 4000,
      includeADRs: true,
    });

    expect(pack.guardrails.relatedADRs).toHaveLength(1);
  });

  it('respects token budget', async () => {
    // Generate many large chunks
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      score: 0.9 - i * 0.01,
      payload: { file: `file${i}.ts`, content: 'x'.repeat(500), language: 'ts' },
    }));
    mocks.search.mockResolvedValue(chunks);

    const pack = await contextPackBuilder.build({
      projectName: 'test',
      query: 'test',
      maxTokens: 200, // very small budget
    });

    expect(pack.totalTokens).toBeLessThanOrEqual(250); // some overhead tolerance
  });

  it('handles facet retrieval failure gracefully', async () => {
    mocks.search.mockRejectedValue(new Error('Qdrant down'));

    const pack = await contextPackBuilder.build({
      projectName: 'test',
      query: 'test',
      maxTokens: 4000,
    });

    // Should not throw, just return empty
    expect(pack.facets).toEqual([]);
    expect(pack.totalTokens).toBe(0);
  });
});
