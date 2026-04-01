## Code Review: rag-api/src/services/embedding.ts

### Summary

Solid service with clean multi-provider abstraction and well-designed session-aware caching. Needs changes -- primarily around input validation, error handling robustness, code duplication, and missing timeout configuration.

### Pattern Compliance

- **Service Layer (Singleton)**: **Pass** -- Follows the pattern exactly: class with private state, public async methods, singleton exported at module bottom (`export const embeddingService = new EmbeddingService()`).
- **Project Isolation via Collection Namespacing**: **Pass** -- Service is project-agnostic; projectName flows through `EmbedOptions` to the cache layer, which handles namespace isolation.
- **Zod Validation Middleware**: **N/A** -- This is a service, not a route. Validation is expected at the route/caller level.

### ADR Compliance

- **Use BGE-M3 as primary embedding model** (accepted): **Compliant** -- BGE-M3 is the first-class provider with dedicated batch and dense+sparse endpoints. Other providers are clean fallbacks.
- **Qdrant as sole vector database with typed collections** (accepted): **Compliant** -- Batch processing respects the batch size limitations documented in the ADR (handled at the caller layer in indexer.ts).

### Issues Found

#### 1. **Warning**: No input validation on `text` parameter

- **Location**: `embedding.ts:47` (`embed`), and all public methods
- **Description**: Empty strings, extremely long strings, or whitespace-only input will be sent to embedding providers, wasting resources and potentially causing confusing errors or zero vectors. The service is called from 21+ downstream files, so it should defend itself.
- **Suggestion**: Add a guard at entry points:
  ```typescript
  if (!text || !text.trim()) {
    throw new Error("Embedding text must be non-empty");
  }
  ```
  Consider also a maximum length check (e.g., 8192 tokens for BGE-M3) to fail fast before an HTTP call.

#### 2. **Warning**: No axios timeout configured on HTTP calls

- **Location**: `embedding.ts:230`, `189`, `280`, `316`, `329`
- **Description**: All `axios.post()` calls use no explicit timeout. If BGE-M3, Ollama, or OpenAI hangs, the embedding call blocks indefinitely. This is especially risky because embedding is on the critical path for search, indexing, and memory operations.
- **Suggestion**: Add a timeout to all axios calls or configure a global axios instance:
  ```typescript
  private readonly httpClient = axios.create({ timeout: 30000 });
  ```

#### 3. **Warning**: Significant code duplication between `embed`, `embedWithSession`, and `embedWithDetails`

- **Location**: `embedding.ts:47-123`
- **Description**: `embedWithDetails` duplicates the exact session-check + cache-lookup + compute + cache-store logic from `embed` and `embedWithSession`. The session-vs-basic cache branching is repeated 3 times (also in `embedBatchWithBGE`). This violates DRY and makes future cache logic changes error-prone.
- **Suggestion**: Extract a unified internal method:
  ```typescript
  private async embedCached(text: string, options?: EmbedOptions): Promise<{ embedding: number[], cacheLevel: CacheLevel }> { ... }
  ```
  Then `embed()` and `embedWithDetails()` become thin wrappers.

#### 4. **Warning**: `embedBatch` falls back to sequential N+1 calls for non-BGE providers

- **Location**: `embedding.ts:128-140`
- **Description**: For Ollama and OpenAI providers, `embedBatch` loops sequentially with `await this.embed(text, options)`. With 100 texts, this makes 100 sequential HTTP calls. OpenAI supports batch embedding natively (`input: string[]`), and even for Ollama, `Promise.all` with concurrency control would be significantly faster.
- **Suggestion**: At minimum, use `Promise.all` with a concurrency limiter (e.g., p-limit). For OpenAI, use the native batch API:
  ```typescript
  // OpenAI supports batch input natively
  const response = await axios.post('.../embeddings', {
    model: 'text-embedding-3-small',
    input: texts,  // array supported
  }, ...);
  ```

#### 5. **Warning**: `error: any` type in all catch blocks

- **Location**: `embedding.ts:194`, `208`, `234`, `308`, `323`, `344`
- **Description**: All catch blocks use `error: any`, which is flagged as a known tech debt item across the codebase (~56 `any` types in MCP tools). The `error.message` access is unguarded -- if the caught value is not an Error, it will be `undefined`.
- **Suggestion**: Use `unknown` type and narrow:
  ```typescript
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('BGE-M3 embedding failed', { error: message });
    throw error;
  }
  ```

#### 6. **Warning**: No retry logic for transient failures

- **Location**: All provider methods (`embedWithBGE`, `embedWithOllama`, `embedWithOpenAI`)
- **Description**: Network hiccups, 429 rate limits, or temporary 503s from providers cause immediate failure. The service is used by 21+ downstream files, all of which would fail. The existing error utilities (`wrapError`, `isRetryableError` from tests) suggest retry infrastructure exists but is not used here.
- **Suggestion**: Add retry with exponential backoff for retryable errors (429, 503, ECONNRESET, ETIMEDOUT). Consider using `axios-retry` or a manual retry wrapper.

#### 7. **Info**: `provider` field is set once in constructor and never updated

- **Location**: `embedding.ts:38-42`
- **Description**: `this.provider` is set from `config.EMBEDDING_PROVIDER` at construction time. If config is hot-reloaded, the embedding service would use a stale provider. This is currently not a real problem (config is static), but typing `provider` as the Config union type would improve type safety:
  ```typescript
  private provider: Config['EMBEDDING_PROVIDER'];
  ```

#### 8. **Info**: `embedFull` and `embedBatchFull` bypass session-aware caching

- **Location**: `embedding.ts:165-185`
- **Description**: `embedFull()` calls `this.embed(text)` without passing options, so it always uses basic (non-session) caching. And for the BGE-M3 path, `embedFullWithBGE` has no caching at all. If these methods are called frequently (e.g., during indexing), the cache is underutilized.
- **Suggestion**: Accept `EmbedOptions` parameter in `embedFull` and `embedBatchFull` for consistency, or document that these are intended for indexing (where caching may not be needed).

#### 9. **Info**: OpenAI model is hardcoded as `'text-embedding-3-small'`

- **Location**: `embedding.ts:333`
- **Description**: The OpenAI model is hardcoded rather than using a config value. The config already has `OPENAI_MODEL` but it is for the LLM, not embeddings. If the user wants `text-embedding-3-large` (3072 dimensions), they must edit source code.
- **Suggestion**: Add `OPENAI_EMBEDDING_MODEL` to the Config interface with a default of `'text-embedding-3-small'`.

#### 10. **Info**: Unused `tokens` field in `EmbeddingResult`

- **Location**: `embedding.ts:18`
- **Description**: The `tokens` field in `EmbeddingResult` is defined but never populated by any method. It could be useful for cost tracking (OpenAI returns `usage.total_tokens`), but it is dead code currently.
- **Suggestion**: Either populate it from OpenAI response (`response.data.usage.total_tokens`) or remove it to avoid confusion.

### Dependency Impact

- **21 downstream consumers** import `embeddingService` directly (routes: search, index, review, testing; services: confluence, feedback, symbol-index, usage-patterns, usage-tracker, code-suggestions, context-pack, feature-estimator, memory-governance, query-learning, session-context, proactive-suggestions, graph-store, predictive-loader, memory, indexer, agent-runtime).
- **No breaking changes** currently -- the public API surface (`embed`, `embedBatch`, `embedFull`, `embedBatchFull`, `embedWithDetails`, `getCacheStats`, `warmSessionCache`) is stable.
- Adding `EmbedOptions` to `embedFull`/`embedBatchFull` would be a non-breaking change (optional parameter).
- The `SparseVector` type is also imported by `context-pack.ts` -- any changes to that interface require updating context-pack.

### Test Coverage

- **Existing tests** (`rag-api/src/__tests__/services/embedding.test.ts`): 6 tests covering:
  - Basic cache hit/miss
  - Session-aware cache hit/miss
  - Batch embedding with partial cache
  - Batch fully-cached (skip HTTP)
  - embedFull (dense + sparse)
  - Error handling (ECONNREFUSED)
- **Missing tests**:
  - `embedWithDetails` -- not tested at all (session path and non-session path)
  - `embedBatchFull` -- not tested
  - `embedBatch` with non-BGE provider (sequential fallback path)
  - `embedBatch` with session options
  - `warmSessionCache` and `getCacheStats` -- trivial delegations, but not verified
  - OpenAI provider path (different response structure: `data.data[0].embedding`)
  - Ollama provider path
  - Error handling per provider (different error shapes)
  - Empty input handling (currently no validation, so no test either)

### Tech Debt

- **Existing debt addressed**: None by this file specifically.
- **Existing debt present**: The `error: any` pattern (Issue #5) is part of the "~56 any types" tech debt item already tracked.
- **New/ongoing debt**:
  - Code duplication in cache branching logic (Issue #3) -- should be refactored before adding new cache levels or options.
  - Missing retry logic (Issue #6) -- the embedding service is the single most critical shared dependency in the system (21 consumers), and it has zero fault tolerance.
  - Sequential batch fallback for non-BGE providers (Issue #4) -- will cause real performance problems if the project ever switches away from BGE-M3.

### Recommended Priority

| Priority | Issue                           | Effort    |
| -------- | ------------------------------- | --------- |
| P1       | Add axios timeout (#2)          | 5 min     |
| P1       | Add input validation (#1)       | 10 min    |
| P2       | Add retry logic (#6)            | 30 min    |
| P2       | Refactor cache duplication (#3) | 45 min    |
| P3       | Fix `error: any` types (#5)     | 15 min    |
| P3       | Add missing tests               | 1-2 hours |
| P4       | OpenAI batch support (#4)       | 30 min    |
| P4       | Configurable OpenAI model (#9)  | 5 min     |
