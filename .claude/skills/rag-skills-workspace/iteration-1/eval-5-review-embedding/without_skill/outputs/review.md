# Code Review: rag-api/src/services/embedding.ts

## File Overview

**Path:** `/home/ake/shared-ai-infra/rag-api/src/services/embedding.ts`
**Lines:** 352
**Purpose:** Multi-provider embedding service with session-aware caching, supporting BGE-M3, Ollama, and OpenAI providers.
**Pattern:** Singleton service (instantiated at module level, exported as `embeddingService`).
**Consumers:** 17+ files across routes, services, and tests.

---

## Summary

The file is well-structured overall and follows the project's established singleton service pattern. It provides a clean public API with progressive feature tiers (basic embed, session-aware embed, detailed embed, batch embed, full dense+sparse embed). However, there are several issues ranging from missing input validation and lack of HTTP timeouts to code duplication and incomplete caching in the `embedFull`/`embedBatchFull` paths.

---

## Issues Found

### CRITICAL

#### 1. No HTTP Request Timeouts (Lines 189, 202, 230, 280, 316, 329-341)

Every `axios.post()` call uses the default axios configuration, which means **no timeout**. If a downstream provider (BGE-M3, Ollama, OpenAI) hangs or is slow to respond, the embedding call will block indefinitely, potentially causing cascading failures across the entire RAG API.

Other services in this project handle this: `confluence.ts` creates an axios instance with timeouts, and `eval/runner.ts` uses `axios.create({ timeout: 30000 })`.

```typescript
// Current: no timeout
const response = await axios.post(`${config.BGE_M3_URL}/embed`, { text });

// Recommended: create an axios instance with timeout
private httpClient = axios.create({ timeout: 30000 });
// Then use: this.httpClient.post(...)
```

**Impact:** Production availability risk. A single slow embedding request can cascade and exhaust Node.js event loop capacity.

#### 2. No Input Validation on `text` Parameter (Lines 47, 70, 165, 215, 228, 314, 327)

None of the public methods validate their input. An empty string, extremely long text, or undefined/null value (if TypeScript checks are bypassed at runtime) would be sent directly to the embedding provider, likely causing cryptic downstream errors or wasted API calls/tokens.

```typescript
// Should validate at entry point:
if (!text || text.trim().length === 0) {
  throw new Error('Embedding text must be non-empty');
}
```

**Impact:** Wasted API calls, confusing error messages, potential billing impact for OpenAI.

---

### HIGH

#### 3. `embedFull` and `embedBatchFull` Bypass All Caching (Lines 165-185, 187-210)

The `embedFull()` and `embedBatchFull()` methods completely skip the caching layer. Every call to `embedFullWithBGE()` or `embedBatchFullWithBGE()` results in an HTTP request even for previously computed text. The non-BGE fallback does go through `this.embed()` (which caches), but only the dense vector benefits.

These methods are called during indexing (`indexer.ts` lines 571, 615, 921, 955, 1285) and search (`search.ts` line 278, `context-pack.ts` line 91), so this is a significant performance gap.

```typescript
// embedFull always makes HTTP call for BGE-M3:
async embedFull(text: string): Promise<FullEmbeddingResult> {
    if (this.provider === 'bge-m3-server') {
      return this.embedFullWithBGE(text); // <-- no cache lookup
    }
    ...
}
```

**Impact:** Unnecessary HTTP calls during indexing and search. During re-indexing, every chunk gets re-embedded even if it hasn't changed.

#### 4. Sequential Cache Lookups in `embedBatchWithBGE` (Lines 247-270)

Cache lookups are done sequentially with `for` loops and `await` on each iteration. For a batch of 100 texts, this means 100 sequential Redis round-trips before the batch HTTP call.

```typescript
// Current: sequential
for (let i = 0; i < texts.length; i++) {
  const { embedding, level } = await cacheService.getSessionEmbedding(texts[i], ...);
  ...
}

// Better: parallel with Promise.all
const cacheResults = await Promise.all(
  texts.map(t => cacheService.getSessionEmbedding(t, options))
);
```

Similarly, the cache-set operations after computing (lines 291-298) are sequential.

**Impact:** Batch operations are slower than necessary. For large indexing jobs, this adds significant latency.

#### 5. Sequential Cache-Store Operations After Batch Compute (Lines 286-299)

After computing uncached embeddings, results are cached one-by-one in a sequential loop. This should be parallelized with `Promise.all`.

---

### MEDIUM

#### 6. Code Duplication: Session vs Non-Session Cache Logic (Lines 47-65, 92-123, 246-270)

The pattern of "check if sessionId+projectName exist, use session cache, else use basic cache" is repeated in three places (`embed`, `embedWithDetails`, `embedBatchWithBGE`). This should be extracted into a helper.

```typescript
// Repeated pattern:
if (options?.sessionId && options?.projectName) {
  // session cache path
} else {
  // basic cache path
}
```

A unified method like `getCachedOrCompute(text, options)` would eliminate this duplication.

#### 7. Hardcoded OpenAI Model Name (Line 333)

The OpenAI model is hardcoded as `'text-embedding-3-small'` rather than being configurable. The config already has `OPENAI_MODEL` for the LLM, but there is no `OPENAI_EMBEDDING_MODEL` equivalent.

```typescript
// Hardcoded:
model: 'text-embedding-3-small',

// Should be configurable:
model: config.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
```

**Impact:** Switching to a different OpenAI embedding model (e.g., `text-embedding-3-large` for 3072 dimensions) requires a code change rather than an environment variable update.

#### 8. `error: any` Type Annotation in Catch Blocks (Lines 194, 207, 234, 308, 322, 345)

Using `error: any` bypasses TypeScript's type safety. The modern TypeScript pattern is `catch (error: unknown)` with an explicit type narrowing.

```typescript
// Current:
} catch (error: any) {
  logger.error('BGE-M3 embedding failed', { error: error.message });

// Better:
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('BGE-M3 embedding failed', { error: message });
  throw error;
}
```

#### 9. No Retry Logic for Transient Failures (All provider methods)

HTTP calls to embedding providers can fail due to transient network issues, but there is no retry mechanism. A simple exponential backoff with 1-2 retries would improve reliability significantly.

The project uses Redis with retry logic (cache.ts has `retryStrategy`), so the pattern exists in the codebase.

#### 10. `embedBatch` Falls Back to Sequential `embed()` for Non-BGE Providers (Lines 134-139)

When the provider is Ollama or OpenAI, `embedBatch` processes texts one-by-one sequentially. OpenAI's API supports batch embedding natively (multiple inputs in one request), and even for Ollama, using `Promise.all` with concurrency control would be faster.

```typescript
// Current for non-BGE:
for (const text of texts) {
  embeddings.push(await this.embed(text, options)); // sequential
}
```

---

### LOW

#### 11. `embedWithDetails` Not Used Anywhere in the Codebase (Lines 92-123)

A grep for `embedWithDetails` across the entire codebase only finds its definition. This is dead code that adds maintenance burden. Consider removing it or adding consumers.

#### 12. `EmbeddingResult.tokens` Field Never Populated (Line 18)

The `EmbeddingResult` interface has a `tokens?: number` field, but no code path ever sets it. OpenAI's embedding response includes token usage (`response.data.usage.total_tokens`), which could populate this field.

#### 13. Provider Set at Construction Time, Not Refreshable (Line 41-42)

The `provider` is read from config once during construction. Since this is a singleton created at module load, the provider can never change at runtime. This is fine for production but makes testing harder (tests must mock at the module level).

#### 14. Missing JSDoc on Several Public Methods

`embedBatch`, `embedFull`, `embedBatchFull` have doc comments, but they don't document parameters, return values, or edge cases (e.g., what happens with empty arrays).

#### 15. `embedBatchWithBGE` Does Not Handle Empty Input Array (Line 240)

If `texts` is an empty array, the method creates `new Array(0)`, skips the loop, returns early because `uncachedTexts.length === 0`, and returns `[]`. This works but is wasteful; an early return would be cleaner.

---

## Test Coverage Assessment

The existing test file (`rag-api/src/__tests__/services/embedding.test.ts`, 175 lines) covers:
- Basic cache hit/miss for `embed()`
- Session-aware caching for `embed()`
- Batch embedding with partial cache hits
- Full embedding (dense + sparse)
- Error handling (network failure)

**Missing test coverage:**
- `embedWithDetails()` (though it may be dead code)
- `embedBatchFull()`
- Ollama and OpenAI provider paths
- Edge cases: empty text, empty batch, very long text
- `warmSessionCache()` and `getCacheStats()` delegation
- Non-BGE batch fallback (sequential embed)

---

## Positive Observations

1. **Clean API design**: Progressive complexity from `embed()` to `embedWithDetails()` to `embedFull()`.
2. **Proper singleton pattern**: Follows the project's established pattern with module-level instantiation.
3. **Cache-first approach**: All basic embed operations check cache before computing, reducing provider load.
4. **Smart batch optimization**: `embedBatchWithBGE` only sends uncached texts to the provider.
5. **Good logging**: Debug-level cache hit logging, error-level failure logging with provider context.
6. **Sparse vector support**: Clean abstraction for dense+sparse (BGE-M3) with graceful degradation for other providers.

---

## Recommended Actions (Priority Order)

1. **Add HTTP timeouts** to all axios calls (or create a shared axios instance with timeout).
2. **Add input validation** for empty/null text at public method entry points.
3. **Add caching to `embedFull`/`embedBatchFull`** to avoid redundant HTTP calls during indexing.
4. **Parallelize cache lookups** in `embedBatchWithBGE` using `Promise.all`.
5. **Extract cache strategy** into a unified helper to reduce duplication.
6. **Make OpenAI model configurable** via environment variable.
7. **Remove or document `embedWithDetails`** if it's truly dead code.
8. **Add retry logic** for transient HTTP failures.
