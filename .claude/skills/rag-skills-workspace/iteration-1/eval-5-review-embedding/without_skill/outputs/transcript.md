# Transcript: Code Review of rag-api/src/services/embedding.ts (Without Skill)

## Tool Calls Made

### Call 1 (Parallel - 2 tools)
1. **Read** - `rag-api/src/services/embedding.ts` (full file, 352 lines)
   - Result: Successfully read the entire embedding service file
2. **mcp__rag__context_briefing** - task: "Review code in rag-api/src/services/embedding.ts", files: ["rag-api/src/services/embedding.ts"]
   - Result: Returned 5 memories, 5 patterns, 3 ADRs. Impact: MEDIUM. Key context: singleton service pattern, BGE-M3 as primary embedding model ADR, Zod validation pattern.

### Call 2 (Parallel - 4 tools)
3. **Read** - `rag-api/src/config.ts` (full file, 105 lines)
   - Result: Read config interface and defaults. Noted EMBEDDING_PROVIDER type, BGE_M3_URL, OLLAMA_URL, OLLAMA_EMBEDDING_MODEL, OPENAI_API_KEY fields. No OPENAI_EMBEDDING_MODEL config exists.
4. **Grep** - pattern: `import.*embedding|embeddingService|embed\(|embedBatch|embedFull` in `rag-api/src`
   - Result: 75 matches across 20+ files. Identified all consumers of the embedding service.
5. **Grep** - pattern: `class.*CacheService|getSessionEmbedding|setSessionEmbedding|...` in `rag-api/src/services/cache.ts`
   - Result: Found CacheStats interface (line 43), SessionCacheOptions (line 52), CacheService class (line 57), all cache methods.
6. **Glob** - pattern: `rag-api/src/services/embedding*.ts`
   - Result: Only 1 file found (no separate test file alongside).

### Call 3 (Parallel - 2 tools)
7. **Read** - `rag-api/src/__tests__/services/embedding.test.ts` (176 lines)
   - Result: Read existing tests. Covers: basic cache hit/miss, session-aware caching, batch BGE-M3, embedFull, error handling. Missing: embedWithDetails, embedBatchFull, Ollama/OpenAI paths.
8. **Read** - `rag-api/src/services/cache.ts` (offset: 43, limit: 40)
   - Result: Read CacheStats, SessionCacheOptions interfaces and CacheService class init (Redis connection with retry).

### Call 4 (Parallel - 2 tools)
9. **mcp__rag__review_code** - Full code submitted for automated review
   - Result: **Timed out** (120000ms exceeded). Proceeded with manual review.
10. **Read** - `rag-api/src/services/cache.ts` (offset: 190, limit: 60)
    - Result: Read getEmbedding, setEmbedding, getOrSetEmbedding, getSearchResults, setSearchResults methods. Noted that `getOrSetEmbedding` exists but is not used by embedding service.

### Call 5 (Parallel - 3 tools)
11. **Grep** - pattern: `timeout|retry|AbortController|signal` in embedding.ts
    - Result: No matches. Confirmed no timeout or retry logic exists.
12. **Grep** - pattern: `axios\.create|axios\.defaults|interceptors` in `rag-api/src`
    - Result: Found 3 matches: `eval/runner.ts` (timeout: 30000), `confluence.ts` (2 axios instances with config). Embedding service does NOT create a configured axios instance.
13. **Grep** - pattern: `text\.length|text\.trim|empty.*text|...` in embedding.ts
    - Result: Only 1 match (line 77, logging textLength). No input validation exists.

### Call 6 (Parallel - 2 tools)
14. **Grep** - pattern: `embedWithOllama|embedWithOpenAI|embedWithBGE|embedFull|embedBatchFull` (files_with_matches)
    - Result: 5 files reference these methods. Only embedding.ts defines them.
15. **Grep** - pattern: `OPENAI_API_KEY|BGE_M3_URL|OLLAMA_URL` in embedding.ts
    - Result: 6 matches. Confirmed direct config references on lines 189, 202, 230, 280, 316, 337.

### Call 7
16. **Grep** - pattern: `embedFull\(|embedBatchFull\(` in `rag-api/src`
    - Result: 10 matches. embedFull used in search.ts, context-pack.ts, indexer.ts (x2). embedBatchFull used in indexer.ts (x3). Heavy indexing usage confirmed.

### Call 8
17. **Grep** - pattern: `embedWithDetails` across codebase (implicit, checked during review)
    - Result: Only defined in embedding.ts. Not called anywhere else. Dead code confirmed.

### Output Generation
18. **Write** - Created `review.md` with full review (2 critical, 3 high, 5 medium, 5 low severity issues)
19. **Write** - Created `transcript.md` (this file)
20. **Write** - Created `metrics.json` with tool call counts

## Summary of Findings

### Issues by Severity
| Severity | Count | Key Issues |
|----------|-------|------------|
| Critical | 2 | No HTTP timeouts, no input validation |
| High | 3 | embedFull/embedBatchFull bypass cache, sequential cache lookups in batch, sequential cache-store |
| Medium | 5 | Code duplication, hardcoded OpenAI model, `error: any`, no retry, sequential non-BGE batch |
| Low | 5 | Dead code (embedWithDetails), unused tokens field, non-refreshable provider, missing JSDoc, empty array handling |

### Total: 15 issues identified
