/**
 * Embedding Service - Multi-provider support with session-aware caching
 *
 * Features:
 * - Multi-provider: BGE-M3, Ollama, OpenAI
 * - Multi-level caching: Session -> Project -> Global
 * - Batch processing support
 * - Cache statistics per session
 */

import axios from 'axios';
import config from '../config';
import { logger } from '../utils/logger';
import { cacheService, SessionCacheOptions, CacheStats } from './cache';
import { withRetry } from '../utils/retry';
import { embeddingCircuit } from '../utils/circuit-breaker';
import { EmbeddingError } from '../utils/errors';

export interface EmbeddingResult {
  embedding: number[];
  tokens?: number;
  cacheLevel?: 'l1' | 'l2' | 'l3' | 'miss';
}

export interface EmbedOptions {
  sessionId?: string;
  projectName?: string;
}

export interface SparseVector {
  indices: number[];
  values: number[];
}

export interface FullEmbeddingResult {
  dense: number[];
  sparse: SparseVector;
}

class EmbeddingService {
  private provider: string;

  constructor() {
    this.provider = config.EMBEDDING_PROVIDER;
  }

  /**
   * Trim input and enforce hard char cap. Throws on empty input; truncates oversize.
   */
  private sanitizeInput(text: string, callsite: string): string {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
      throw new EmbeddingError('empty input', { callsite });
    }
    if (trimmed.length > config.EMBEDDING_MAX_INPUT_CHARS) {
      logger.warn('Truncating oversize embedding input', {
        callsite,
        len: trimmed.length,
        limit: config.EMBEDDING_MAX_INPUT_CHARS,
      });
      return trimmed.slice(0, config.EMBEDDING_MAX_INPUT_CHARS);
    }
    return trimmed;
  }

  /**
   * Validate provider output. Throws on empty / undersized vectors.
   * Returns the vector truncated to VECTOR_SIZE (MRL truncation for Qwen3 etc.).
   */
  private validateOutput(vec: unknown, callsite: string, inputLen: number): number[] {
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new EmbeddingError('provider returned empty vector', {
        callsite,
        inputLen,
        provider: this.provider,
      });
    }
    if (vec.length < config.VECTOR_SIZE) {
      throw new EmbeddingError('provider returned vector smaller than VECTOR_SIZE', {
        callsite,
        got: vec.length,
        expected: config.VECTOR_SIZE,
        provider: this.provider,
      });
    }
    return (vec as number[]).slice(0, config.VECTOR_SIZE);
  }

  /**
   * Embed text with optional session-aware caching
   */
  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    // Use session-aware caching if session context provided
    if (options?.sessionId && options?.projectName) {
      return this.embedWithSession(text, {
        sessionId: options.sessionId,
        projectName: options.projectName,
      });
    }

    // Fallback to basic caching
    const cached = await cacheService.getEmbedding(text);
    if (cached) {
      return cached;
    }

    const embedding = await this.computeEmbedding(text);
    await cacheService.setEmbedding(text, embedding);
    return embedding;
  }

  /**
   * Embed with session-aware multi-level caching
   */
  async embedWithSession(text: string, options: SessionCacheOptions): Promise<number[]> {
    // Try multi-level cache
    const { embedding, level } = await cacheService.getSessionEmbedding(text, options);
    if (embedding) {
      logger.debug('Embedding cache hit', { level, textLength: text.length });
      return embedding;
    }

    // Compute embedding
    const computed = await this.computeEmbedding(text);

    // Store in all cache levels
    await cacheService.setSessionEmbedding(text, computed, options);
    return computed;
  }

  /**
   * Embed with detailed result including cache info
   */
  async embedWithDetails(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
    if (options?.sessionId && options?.projectName) {
      const { embedding, level } = await cacheService.getSessionEmbedding(text, {
        sessionId: options.sessionId,
        projectName: options.projectName,
      });

      if (embedding) {
        return { embedding, cacheLevel: level };
      }

      const computed = await this.computeEmbedding(text);
      await cacheService.setSessionEmbedding(text, computed, {
        sessionId: options.sessionId,
        projectName: options.projectName,
      });
      return { embedding: computed, cacheLevel: 'miss' };
    }

    // Non-session embed
    const cached = await cacheService.getEmbedding(text);
    if (cached) {
      return { embedding: cached, cacheLevel: 'l2' };
    }

    const embedding = await this.computeEmbedding(text);
    await cacheService.setEmbedding(text, embedding);
    return { embedding, cacheLevel: 'miss' };
  }

  /**
   * Batch embed with session awareness
   */
  async embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    // BGE-M3 server batch
    if (this.provider === 'bge-m3-server') {
      return this.embedBatchWithBGE(texts, options);
    }

    // Ollama batch via /api/embed (array input)
    if (this.provider === 'ollama') {
      return this.embedBatchOllama(texts, options);
    }

    // Fallback: embed one by one with caching
    const embeddings: number[][] = [];
    for (const text of texts) {
      embeddings.push(await this.embed(text, options));
    }
    return embeddings;
  }

  /**
   * Get embedding cache stats for a session
   */
  async getCacheStats(sessionId: string): Promise<CacheStats> {
    return cacheService.getSessionStats(sessionId);
  }

  /**
   * Warm session cache
   */
  async warmSessionCache(options: {
    sessionId: string;
    projectName: string;
    previousSessionId?: string;
    recentQueries?: string[];
  }): Promise<{ warmedCount: number }> {
    return cacheService.warmSessionCache(options);
  }

  /**
   * Get dense + sparse embedding for a single text.
   * Only supported with BGE-M3 provider; others return empty sparse.
   */
  async embedFull(text: string): Promise<FullEmbeddingResult> {
    if (this.provider === 'bge-m3-server') {
      return this.embedFullWithBGE(text);
    }
    // Fallback: dense only
    const dense = await this.embed(text);
    return { dense, sparse: { indices: [], values: [] } };
  }

  /**
   * Get dense + sparse embeddings for a batch of texts.
   * Only supported with BGE-M3 provider; others return empty sparse.
   */
  async embedBatchFull(texts: string[]): Promise<FullEmbeddingResult[]> {
    if (this.provider === 'bge-m3-server') {
      return this.embedBatchFullWithBGE(texts);
    }
    // Fallback: dense only
    const embeddings = await this.embedBatch(texts);
    return embeddings.map((dense) => ({ dense, sparse: { indices: [], values: [] } }));
  }

  private async embedFullWithBGE(text: string): Promise<FullEmbeddingResult> {
    const safe = this.sanitizeInput(text, 'embedFullWithBGE');
    try {
      const response = await embeddingCircuit.execute(() =>
        withRetry(
          () => axios.post(`${config.BGE_M3_URL}/embed/full`, { text: safe }),
          { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 5000, timeoutMs: 15000 },
          'embedding.bge-m3.full'
        )
      );
      const dense = this.validateOutput(response.data.dense, 'embedFullWithBGE', safe.length);
      return {
        dense,
        sparse: response.data.sparse ?? { indices: [], values: [] },
      };
    } catch (error: any) {
      if (error instanceof EmbeddingError) throw error;
      logger.error('BGE-M3 full embedding failed', { error: error.message });
      throw error;
    }
  }

  private async embedBatchFullWithBGE(texts: string[]): Promise<FullEmbeddingResult[]> {
    const safeTexts = texts.map((t, i) => this.sanitizeInput(t, `embedBatchFullWithBGE[${i}]`));
    try {
      const response = await embeddingCircuit.execute(() =>
        withRetry(
          () => axios.post(`${config.BGE_M3_URL}/embed/batch/full`, { texts: safeTexts }),
          { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10000, timeoutMs: 30000 },
          'embedding.bge-m3.batchFull'
        )
      );
      const dense: unknown[] = response.data.dense ?? [];
      const sparse: SparseVector[] = response.data.sparse ?? [];
      return dense.map((d, i) => ({
        dense: this.validateOutput(d, `embedBatchFullWithBGE[${i}]`, safeTexts[i].length),
        sparse: sparse[i] ?? { indices: [], values: [] },
      }));
    } catch (error: any) {
      if (error instanceof EmbeddingError) throw error;
      logger.error('BGE-M3 batch full embedding failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Compute embedding (no caching) — wrapped with circuit breaker + retry
   */
  private async computeEmbedding(text: string): Promise<number[]> {
    return embeddingCircuit.execute(() =>
      withRetry(
        () => {
          switch (this.provider) {
            case 'bge-m3-server':
              return this.embedWithBGE(text);
            case 'ollama':
              return this.embedWithOllama(text);
            case 'openai':
              return this.embedWithOpenAI(text);
            default:
              throw new Error(`Unknown embedding provider: ${this.provider}`);
          }
        },
        { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 5000, timeoutMs: 15000 },
        `embedding.${this.provider}`
      )
    );
  }

  private async embedWithBGE(text: string): Promise<number[]> {
    const safe = this.sanitizeInput(text, 'embedWithBGE');
    try {
      const response = await axios.post(`${config.BGE_M3_URL}/embed`, {
        text: safe,
      });
      return this.validateOutput(response.data.embedding, 'embedWithBGE', safe.length);
    } catch (error: any) {
      if (error instanceof EmbeddingError) throw error;
      logger.error('BGE-M3 embedding failed', { error: error.message });
      throw error;
    }
  }

  private async embedBatchWithBGE(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const embeddings: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Sanitize all inputs upfront so cache lookups also use the cleaned key.
    const safeTexts = texts.map((t, i) => this.sanitizeInput(t, `embedBatchWithBGE[${i}]`));

    // Check cache for each text
    if (options?.sessionId && options?.projectName) {
      for (let i = 0; i < safeTexts.length; i++) {
        const { embedding } = await cacheService.getSessionEmbedding(safeTexts[i], {
          sessionId: options.sessionId,
          projectName: options.projectName,
        });
        if (embedding) {
          embeddings[i] = embedding;
        } else {
          uncachedIndices.push(i);
          uncachedTexts.push(safeTexts[i]);
        }
      }
    } else {
      // Basic cache check
      for (let i = 0; i < safeTexts.length; i++) {
        const cached = await cacheService.getEmbedding(safeTexts[i]);
        if (cached) {
          embeddings[i] = cached;
        } else {
          uncachedIndices.push(i);
          uncachedTexts.push(safeTexts[i]);
        }
      }
    }

    // If everything was cached, return
    if (uncachedTexts.length === 0) {
      logger.debug('Batch embedding fully cached', { count: texts.length });
      return embeddings;
    }

    // Compute uncached embeddings (with circuit breaker + retry)
    try {
      const response = await embeddingCircuit.execute(() =>
        withRetry(
          () => axios.post(`${config.BGE_M3_URL}/embed/batch`, { texts: uncachedTexts }),
          { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10000, timeoutMs: 30000 },
          'embedding.bge-m3.batch'
        )
      );
      const computed: unknown[] = response.data.embeddings ?? [];

      // Store in cache and fill results
      for (let i = 0; i < uncachedIndices.length; i++) {
        const originalIndex = uncachedIndices[i];
        const validated = this.validateOutput(
          computed[i],
          `embedBatchWithBGE[${originalIndex}]`,
          uncachedTexts[i].length
        );
        embeddings[originalIndex] = validated;

        // Cache the result
        if (options?.sessionId && options?.projectName) {
          await cacheService.setSessionEmbedding(uncachedTexts[i], validated, {
            sessionId: options.sessionId,
            projectName: options.projectName,
          });
        } else {
          await cacheService.setEmbedding(uncachedTexts[i], validated);
        }
      }

      logger.debug('Batch embedding completed', {
        total: texts.length,
        cached: texts.length - uncachedTexts.length,
        computed: uncachedTexts.length,
      });

      return embeddings;
    } catch (error: any) {
      if (error instanceof EmbeddingError) throw error;
      logger.error('BGE-M3 batch embedding failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Task-specific instruction prefixes for Qwen3-Embedding.
   * Queries get prefixed; documents do not.
   */
  private readonly TASK_INSTRUCTIONS: Record<string, string> = {
    code_search:
      'Given a code search query, retrieve relevant source code snippets that match the query',
    memory_recall: 'Given a memory query, retrieve relevant past decisions, insights and context',
    doc_search: 'Given a technical question, retrieve relevant documentation passages',
    general: 'Given a search query, retrieve relevant text passages that answer the query',
  };

  /**
   * Embed a query with instruction prefix (for search/recall).
   * Uses Ollama /api/embed endpoint with batch support and MRL truncation.
   */
  async embedQuery(text: string, task: string = 'general'): Promise<number[]> {
    let input = text;
    if (config.EMBEDDING_INSTRUCTION_ENABLED && this.provider === 'ollama') {
      const instruction = this.TASK_INSTRUCTIONS[task] || this.TASK_INSTRUCTIONS.general;
      input = `Instruct: ${instruction}\nQuery: ${text}`;
    }
    return this.embed(input);
  }

  /**
   * Embed a document (for indexing/storage). No instruction prefix.
   */
  async embedDocument(text: string, options?: EmbedOptions): Promise<number[]> {
    return this.embed(text, options);
  }

  /**
   * Batch embed documents via Ollama /api/embed (array input).
   *
   * Each batch element is sanitized; per-element validation lets us recover
   * a single bad chunk by falling back to sequential without poisoning the batch.
   */
  async embedBatchOllama(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const embeddings: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Sanitize upfront so cache lookups use the cleaned key.
    const safeTexts = texts.map((t, i) => this.sanitizeInput(t, `embedBatchOllama[${i}]`));

    // Check cache first
    for (let i = 0; i < safeTexts.length; i++) {
      const cached =
        options?.sessionId && options?.projectName
          ? (
              await cacheService.getSessionEmbedding(safeTexts[i], {
                sessionId: options.sessionId,
                projectName: options.projectName,
              })
            ).embedding
          : await cacheService.getEmbedding(safeTexts[i]);
      if (cached) {
        embeddings[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(safeTexts[i]);
      }
    }

    if (uncachedTexts.length === 0) return embeddings;

    // Batch via /api/embed (supports array input)
    const BATCH_SIZE = 32;
    for (let b = 0; b < uncachedTexts.length; b += BATCH_SIZE) {
      const batch = uncachedTexts.slice(b, b + BATCH_SIZE);
      let computed: unknown[] | null = null;
      try {
        const response = await axios.post(
          `${config.OLLAMA_URL}/api/embed`,
          {
            model: config.OLLAMA_EMBEDDING_MODEL,
            input: batch,
          },
          { timeout: 60000 }
        );
        computed = response.data?.embeddings ?? null;
      } catch (error: any) {
        logger.error('Ollama batch embedding failed', {
          error: error.message,
          batchSize: batch.length,
        });
      }

      for (let j = 0; j < batch.length; j++) {
        const idx = uncachedIndices[b + j];
        const candidate = computed?.[j];
        let vec: number[] | null = null;
        if (candidate !== undefined) {
          try {
            vec = this.validateOutput(candidate, `embedBatchOllama[${idx}]`, batch[j].length);
          } catch (err) {
            // Bad embedding for this slot — fall through to sequential fallback.
            logger.warn('Ollama returned invalid embedding for batch slot, falling back', {
              slot: idx,
              inputLen: batch[j].length,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (!vec) {
          // Per-text fallback (also goes through circuit breaker + retry + validation).
          // If the fallback ALSO fails (e.g. provider regression that hits the same
          // input again), we MUST NOT throw out of this loop — that would kill the
          // remaining 31 valid embeddings. Park an empty placeholder; the indexer's
          // filterValidDensePoints will drop it before upsert and bump stats.errors.
          try {
            vec = await this.computeEmbedding(batch[j]);
          } catch (fallbackErr) {
            logger.warn('Ollama per-slot fallback failed, slot will be skipped at upsert', {
              slot: idx,
              inputLen: batch[j].length,
              reason: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            });
            embeddings[idx] = [];
            continue; // do not cache an empty vector
          }
        }
        embeddings[idx] = vec;

        if (options?.sessionId && options?.projectName) {
          await cacheService.setSessionEmbedding(batch[j], vec, {
            sessionId: options.sessionId,
            projectName: options.projectName,
          });
        } else {
          await cacheService.setEmbedding(batch[j], vec);
        }
      }
    }

    logger.debug('Ollama batch embedding completed', {
      total: texts.length,
      cached: texts.length - uncachedTexts.length,
      computed: uncachedTexts.length,
    });

    return embeddings;
  }

  private async embedWithOllama(text: string): Promise<number[]> {
    const safe = this.sanitizeInput(text, 'embedWithOllama');
    try {
      const response = await axios.post(
        `${config.OLLAMA_URL}/api/embed`,
        {
          model: config.OLLAMA_EMBEDDING_MODEL,
          input: safe,
        },
        { timeout: 30000 }
      );
      // validateOutput slices to VECTOR_SIZE (Qwen3 MRL emits up to 2560d).
      return this.validateOutput(response.data?.embeddings?.[0], 'embedWithOllama', safe.length);
    } catch (error: any) {
      if (error instanceof EmbeddingError) throw error;
      logger.error('Ollama embedding failed', { error: error.message });
      throw error;
    }
  }

  private async embedWithOpenAI(text: string): Promise<number[]> {
    const safe = this.sanitizeInput(text, 'embedWithOpenAI');
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        {
          model: 'text-embedding-3-small',
          input: safe,
        },
        {
          headers: {
            Authorization: `Bearer ${config.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      return this.validateOutput(
        response.data?.data?.[0]?.embedding,
        'embedWithOpenAI',
        safe.length
      );
    } catch (error: any) {
      if (error instanceof EmbeddingError) throw error;
      logger.error('OpenAI embedding failed', { error: error.message });
      throw error;
    }
  }
}

export const embeddingService = new EmbeddingService();
export default embeddingService;
