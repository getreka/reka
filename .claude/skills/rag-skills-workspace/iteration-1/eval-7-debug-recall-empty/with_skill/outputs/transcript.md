# Debug Transcript: recall повертає порожній масив

## Step 1: Parse the Problem

- **Symptom**: `recall` MCP tool returns an empty array
- **Condition**: Memories exist in the collection
- **No errors** visible in logs
- **Affected component**: Memory recall pipeline (MCP -> RAG API -> Qdrant)

## Step 2: Context + Memory (parallel)

### Tool calls:
1. `context_briefing(task: "debug: recall returns empty array even when memories exist in collection. No errors in logs.", files: ["mcp-server/src/tools/search.ts", "rag-api/src/services/memory.ts", "rag-api/src/routes/memory.ts"])`
   - **Result**: Retrieved 5 memories (observability gaps, enrichment ADR, scalability, memory governance, eval baseline), 5 patterns (Memory Dual-Tier, Express Route, Tool Registration, Service Layer, Project Isolation), 3 ADRs (enrichment, zero-downtime, Qdrant)

2. `recall(query: "bug recall empty array memories collection")`
   - **Result**: 5 memories recalled (Memory Dual-Tier Governance pattern, Qdrant orphaned alias fix, context enrichment ADR, low test coverage tech debt, zero-downtime reindexing ADR). Relevance 43.9-45.6%.

## Step 3: Trace Dependencies

### Tool calls:
3. `search_graph(query: "recall memory search empty results", expandHops: 2)`
   - **Result**: Direct matches:
     - `mcp-server/src/tools/memory.ts:28-684` (55.6%) — createMemoryTools
     - `rag-api/src/__tests__/services/memory.test.ts:106-140` (55.1%)
     - `rag-api/src/services/memory-governance.ts:260-294` (54.0%) — recallQuarantine
     - `rag-api/src/services/memory.ts:142-212` (53.9%) — MemoryService.recall
     - Graph-connected: vector-store.ts (search), embedding.ts (embedBatch), feedback.ts, quality-gates.ts, logger.ts

4. `find_symbol(symbol: "recall")`
   - **Result**: Found symbols:
     - `recall` in `rag-api/src/services/memory.ts` (exported)
     - `recallQuarantine` in `rag-api/src/services/memory-governance.ts`
     - `recallDurable` in `rag-api/src/services/memory-governance.ts`
     - `recallWithTimeout` in `mcp-server/src/context-enrichment.ts`
     - `recallMemorySchema` in `rag-api/src/utils/validation.ts`
     - `recallAtK` in `rag-api/src/eval/metrics.ts`

5. `hybrid_search(query: "recall returns empty array no results memory search", limit: 10)`
   - **Result**: 10 results covering memory.ts recall, memory-governance.ts, MCP tools, formatters, validation, routes

## Step 4: Analyze — Read key files

### Files read:
6. **Read** `rag-api/src/services/memory.ts` (full, 845 lines)
   - `MemoryService.recall()` at line 142-212
   - Collection name: `{projectName}_agent_memory`
   - Search flow: embed query -> vectorStore.search(collection, embedding, limit*2, filter) -> filter superseded -> apply aging -> sort -> slice

7. **Read** `rag-api/src/services/memory-governance.ts` (full, 430 lines)
   - `recallDurable()` delegates to `memoryService.recall()`
   - `recallQuarantine()` searches quarantine collection directly

8. **Read** `rag-api/src/routes/memory.ts` (full, 376 lines)
   - `/api/memory/recall` route (line 62-74): returns `res.json({ results })`
   - `/api/memory/recall-durable` route (line 185-197): returns `res.json({ results })`

9. **Read** `rag-api/src/services/vector-store.ts` (lines 480-560)
   - `search()` method: tries named vector `{ name: 'dense', vector }` first, catches 400 -> fallback to anonymous, catches 404 -> returns `[]` silently

10. **Read** `mcp-server/src/tools/memory.ts` (full, 488 lines)
    - `recall` tool handler: calls `/api/memory/recall`, reads `response.data.results`

11. **Read** `mcp-server/src/context-enrichment.ts` (full, 270 lines)
    - `recallWithTimeout()` at line 184-258: calls `/api/memory/recall-durable`, reads `memoriesRes.data.memories` — **BUG: should read `.results` not `.memories`**

12. **Read** `mcp-server/src/index.ts` (full, 144 lines) — registration, context setup

13. **Read** `mcp-server/src/api-client.ts` (full, 24 lines) — X-Project-Name header setup

14. **Read** `rag-api/src/utils/validation.ts` (lines 297-345) — validateProjectName middleware, recallMemorySchema

15. **Read** `rag-api/src/services/vector-store.ts` (lines 1-120) — collection creation, INDEXED_FIELDS

16. **Read** `rag-api/src/services/vector-store.ts` (lines 125-225) — ensureCollection (anonymous vectors)

17. **Read** `rag-api/src/services/vector-store.ts` (lines 250-355) — upsert (anonymous), ensureCollectionWithSparse (named vectors)

18. **Read** `rag-api/src/routes/index.ts` (lines 50-65) — ensure-collections uses ensureCollection (anonymous)

19. **Read** `mcp-server/src/tools/suggestions.ts` (lines 16-136) — context_briefing handler, reads `memoriesRes?.data?.results || memoriesRes?.data?.memories || []`

20. **Read** `rag-api/src/__tests__/services/vector-store.test.ts` (lines 110-147) — search fallback test

## Step 5: Root Cause Analysis

### Identified Issues (3 total, 1 primary):

#### Issue #1 (PRIMARY): Silent 404 return in vectorStore.search()
**File**: `rag-api/src/services/vector-store.ts:522-525`
```typescript
if (error.status === 404) {
  return [];
}
```
When the collection `{project}_agent_memory` does not exist (e.g., never created, or deleted/recreated under different name), the `search` method silently returns an empty array. The `recall` service passes this empty array through its pipeline and returns it. No error, no log entry.

**Why "no errors in logs"**: The 404 is caught and swallowed. `MemoryService.recall()` doesn't log the empty result case. The MCP tool says "No memories found" which is not an error.

**Why "memories exist in collection"**: The memories may have been stored via `remember()`, which calls `vectorStore.upsert()` -> `ensureCollection()`. If the collection was subsequently deleted (e.g., during a failed reindex, cleanup, or if there's an alias conflict), the memories are gone but the user may have verified existence via a different method (e.g., checking another collection or an alias).

#### Issue #2 (SECONDARY): Context enrichment response field mismatch
**File**: `mcp-server/src/context-enrichment.ts:227,241`
```typescript
if (memoriesRes?.data?.memories) {  // BUG: should be .results
```
Both `/api/memory/recall` and `/api/memory/recall-durable` return `{ results: [...] }`, but `recallWithTimeout` reads `memoriesRes.data.memories`, which is always `undefined`. This means context enrichment **never** enriches tool results with recalled memories.

#### Issue #3 (LATENT): Superseded chain exhaustion
**File**: `rag-api/src/services/memory.ts:748`
```typescript
if (r.score > 0.85 && existingType === type) {
  relations.push({ targetId: r.id, type: 'supersedes', ... });
}
```
When many similar memories of the same type are stored, `detectRelationships` marks older ones as superseded (similarity > 0.85 + same type). Over many `remember()` calls, superseded chains can grow. Line 171's `.filter(r => !r.payload.supersededBy)` removes all superseded memories from results. If the memory pool is small and many are similar, recall results shrink significantly.

### Additional findings:
- **`tags` field not indexed**: `INDEXED_FIELDS` in vector-store.ts does not include `tags`, but tag filtering (`match: { any: [...] }`) still works via full scan — just slower.
- **`validated` indexed as keyword but stored as boolean**: `validated: false` is stored as boolean, but the Qdrant keyword index expects strings. This may cause `getUnvalidatedMemories` filter to miss points, but doesn't affect recall.

## Step 6: Verification

### Tool calls:
21. `search_codebase(query: "collection not found 404 recall search memory empty silent")` — confirmed the silent 404 pattern is consistent across the codebase

22. `suggest_related_code(code: "async recall(...) { ... vectorStore.search(...) ... .filter(r => !r.payload.supersededBy)")` — API error, skipped

### Verification via grep:
23. Grep for `ensureCollection.*agent_memory` — no explicit initialization of agent_memory outside upsert's auto-creation and ensure-collections route
24. Grep for `Bad Request` — only in vector-store search fallback and test
25. Grep for `ensureCollectionWithSparse` — only in vector-store.ts and upsertSparse (not used for memory)

## Summary

The most probable root cause is **Issue #1**: the `{project}_agent_memory` collection returns 404 from Qdrant, causing `vectorStore.search()` to silently return an empty array. This propagates through `MemoryService.recall()` with zero log output.

The confirmed bug is **Issue #2**: context enrichment reads the wrong response field (`.memories` instead of `.results`), making auto-enrichment of tool responses with memories completely broken.

Both issues produce the same symptom: "recall returns empty, no errors."
