import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { mockEmbedding } from '../helpers/fixtures';

// Mock axios before importing the module under test
vi.mock('axios', () => ({
  default: { post: vi.fn() },
}));

// Mock cache service
vi.mock('../../services/cache', () => ({
  cacheService: {
    getEmbedding: vi.fn(),
    setEmbedding: vi.fn(),
    getSessionEmbedding: vi.fn(),
    setSessionEmbedding: vi.fn(),
    getSessionStats: vi.fn(),
    warmSessionCache: vi.fn(),
  },
}));

import { cacheService } from '../../services/cache';
import { embeddingService } from '../../services/embedding';
import { embeddingCircuit } from '../../utils/circuit-breaker';

const mockedAxios = vi.mocked(axios);
const mockedCache = vi.mocked(cacheService);

describe('EmbeddingService', () => {
  const fakeVector = mockEmbedding(1024);

  beforeEach(() => {
    vi.clearAllMocks();
    // Circuit breaker state is module-level singleton — reset between tests
    // so earlier failures don't poison later ones.
    embeddingCircuit.reset();
  });

  describe('embed (basic caching)', () => {
    it('returns cached embedding on cache hit', async () => {
      mockedCache.getEmbedding.mockResolvedValue(fakeVector);

      const result = await embeddingService.embed('hello');

      expect(result).toBe(fakeVector);
      expect(mockedCache.getEmbedding).toHaveBeenCalledWith('hello');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('computes and caches on cache miss', async () => {
      mockedCache.getEmbedding.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValue({
        data: { embedding: fakeVector },
      });

      const result = await embeddingService.embed('hello');

      // validateOutput slices to VECTOR_SIZE, so we deep-equal instead of identity.
      expect(result).toEqual(fakeVector);
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/embed'), {
        text: 'hello',
      });
      expect(mockedCache.setEmbedding).toHaveBeenCalledWith('hello', fakeVector);
    });
  });

  describe('embed (session-aware caching)', () => {
    it('uses session cache when session context provided', async () => {
      mockedCache.getSessionEmbedding.mockResolvedValue({
        embedding: fakeVector,
        level: 'l1' as const,
      });

      const result = await embeddingService.embed('query', {
        sessionId: 'sess-1',
        projectName: 'proj',
      });

      expect(result).toBe(fakeVector);
      expect(mockedCache.getSessionEmbedding).toHaveBeenCalledWith('query', {
        sessionId: 'sess-1',
        projectName: 'proj',
      });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('computes and stores in session cache on miss', async () => {
      mockedCache.getSessionEmbedding.mockResolvedValue({
        embedding: null,
        level: undefined as any,
      });
      mockedAxios.post.mockResolvedValue({
        data: { embedding: fakeVector },
      });

      const result = await embeddingService.embed('query', {
        sessionId: 'sess-1',
        projectName: 'proj',
      });

      expect(result).toEqual(fakeVector);
      expect(mockedAxios.post).toHaveBeenCalled();
      expect(mockedCache.setSessionEmbedding).toHaveBeenCalledWith('query', fakeVector, {
        sessionId: 'sess-1',
        projectName: 'proj',
      });
    });
  });

  describe('embedBatch (BGE-M3)', () => {
    it('calls /embed/batch for uncached texts', async () => {
      const vec1 = mockEmbedding(1024);
      const vec2 = mockEmbedding(1024);

      // First text cached, second not
      mockedCache.getEmbedding.mockResolvedValueOnce(vec1).mockResolvedValueOnce(null);

      mockedAxios.post.mockResolvedValue({
        data: { embeddings: [vec2] },
      });

      const result = await embeddingService.embedBatch(['cached', 'uncached']);

      expect(result).toHaveLength(2);
      // Cached value passes through as-is; computed value is sliced (new array).
      expect(result[0]).toBe(vec1);
      expect(result[1]).toEqual(vec2);
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/embed/batch'), {
        texts: ['uncached'],
      });
    });

    it('skips HTTP call when all texts are cached', async () => {
      const vec1 = mockEmbedding(1024);
      const vec2 = mockEmbedding(1024);

      mockedCache.getEmbedding.mockResolvedValueOnce(vec1).mockResolvedValueOnce(vec2);

      const result = await embeddingService.embedBatch(['a', 'b']);

      expect(result).toHaveLength(2);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('embedFull', () => {
    it('returns dense + sparse from BGE-M3', async () => {
      const dense = mockEmbedding(1024);
      const sparse = { indices: [1, 5, 10], values: [0.8, 0.5, 0.3] };

      mockedAxios.post.mockResolvedValue({
        data: { dense, sparse },
      });

      const result = await embeddingService.embedFull('test text');

      expect(result.dense).toEqual(dense);
      expect(result.sparse).toEqual(sparse);
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/embed/full'), {
        text: 'test text',
      });
    });
  });

  describe('error handling', () => {
    it('throws on network failure', async () => {
      mockedCache.getEmbedding.mockResolvedValue(null);
      mockedAxios.post.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(embeddingService.embed('fail')).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('input/output guards', () => {
    it('rejects empty input', async () => {
      mockedCache.getEmbedding.mockResolvedValue(null);

      await expect(embeddingService.embed('')).rejects.toThrow(/empty input/);
      await expect(embeddingService.embed('   \n\t')).rejects.toThrow(/empty input/);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('throws EmbeddingError when provider returns empty vector', async () => {
      mockedCache.getEmbedding.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValue({ data: { embedding: [] } });

      await expect(embeddingService.embed('hi')).rejects.toThrow(/empty vector/);
    });

    it('throws EmbeddingError when provider returns short vector', async () => {
      mockedCache.getEmbedding.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValue({ data: { embedding: mockEmbedding(512) } });

      await expect(embeddingService.embed('hi')).rejects.toThrow(/smaller than VECTOR_SIZE/);
    });

    it('truncates oversize input before sending to provider', async () => {
      mockedCache.getEmbedding.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValue({ data: { embedding: fakeVector } });

      const huge = 'a'.repeat(50_000);
      await embeddingService.embed(huge);

      const sent = mockedAxios.post.mock.calls[0][1] as { text: string };
      expect(sent.text.length).toBeLessThanOrEqual(24_000);
    });

    it('embedBatch: short vector at any slot fails the batch', async () => {
      // BGE batch path — provider returns one valid + one short vector.
      mockedCache.getEmbedding.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValue({
        data: { embeddings: [fakeVector, mockEmbedding(100)] },
      });

      await expect(embeddingService.embedBatch(['a', 'b'])).rejects.toThrow(
        /smaller than VECTOR_SIZE/
      );
    });
  });
});
