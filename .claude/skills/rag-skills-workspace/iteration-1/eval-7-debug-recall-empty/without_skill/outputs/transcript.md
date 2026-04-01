# Debug Recall Empty - Investigation Transcript (without skill)

## Task

"recall returns empty array even when memories exist in collection. No errors in logs."

## Investigation Steps

### 1. Identify the Recall Flow

Read files to trace the complete recall path from MCP tool to Qdrant:

**Files read:**

- `/home/ake/shared-ai-infra/mcp-server/src/tools/memory.ts` - MCP tool definition for `recall`
- `/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts` - Express route handler for `/api/memory/recall`
- `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts` - MemoryService.recall() method
- `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts` - VectorStore.search() method
- `/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts` - Memory governance (dual-tier storage)
- `/home/ake/shared-ai-infra/rag-api/src/utils/validation.ts` - Zod schemas for request validation

**Call chain:**

```
MCP recall tool (memory.ts:80-99)
  -> POST /api/memory/recall (routes/memory.ts:62-74)
     -> validateProjectName middleware (validation.ts:297-323)
     -> validate(recallMemorySchema) middleware (validation.ts:266-292)
     -> memoryService.recall() (memory.ts:142-212)
        -> embeddingService.embed(query)
        -> vectorStore.search(collectionName, embedding, limit*2, filter) (vector-store.ts:495-540)
           -> Qdrant client.search() with named vector "dense" first
           -> On 400 error: fallback to anonymous vector search
           -> On 404 error: return [] silently
        -> filter out supersededBy memories
        -> apply aging decay
        -> sort and slice
     -> res.json({ results })
  -> response.data.results || []
```

### 2. Searched for Collection Name Mismatches

Used Grep to check all references to `agent_memory` and `_memory` across the codebase.

**Result:** All paths consistently use `${projectName}_agent_memory` via `getCollectionName()`. No mismatch found.

### 3. Analyzed Vector Store Search Method

The `search()` method (vector-store.ts:495-540) has a two-step search strategy:

```typescript
try {
    // Step 1: Try named vector "dense" first
    const namedVector = { name: 'dense', vector } as any;
    const results = await this.client.search(collection, {
        vector: namedVector,
        ...searchParams,
    });
    return results.map(...);
} catch (error: any) {
    if (error.status === 404) {
        return [];  // <-- SILENT empty return, no error logged
    }
    if (error.message?.includes('Bad Request') || error.status === 400) {
        // Step 2: Fallback to anonymous vector
        const results = await this.client.search(collection, {
            vector, // anonymous format
            ...searchParams,
        });
        return results.map(...);
    }
    throw error;
}
```

### 4. Analyzed Qdrant JS Client Error Handling

Read the Qdrant JS client source (`@qdrant/js-client-rest@^1.16.2`):

**Files read:**

- `node_modules/@qdrant/js-client-rest/dist/cjs/errors.js`
- `node_modules/@qdrant/js-client-rest/dist/cjs/api-client.js`
- `node_modules/@qdrant/js-client-rest/dist/cjs/qdrant-client.js`
- `node_modules/@qdrant/openapi-typescript-fetch/dist/cjs/fetcher.js`
- `node_modules/@qdrant/openapi-typescript-fetch/dist/cjs/types.js`

**Key finding:** The error thrown by the Qdrant client for HTTP 400 responses is an `ApiError` which HAS a `.status` property (set from `response.status`). The fallback check `error.status === 400` should correctly trigger for anonymous vector collections.

### 5. Analyzed Collection Creation Path

The `_agent_memory` collection is created by:

- `ensureCollection()` via `upsert()` during `remember()` calls
- `ensure-collections` endpoint during MCP auto-session start

Both use `ensureCollection()` which creates collections with **anonymous vectors** (not named vectors).

### 6. Checked Middleware Chain

Read middleware files:

- `mcp-server/src/tool-middleware.ts` - MCP tool wrapper with timeout and error handling
- `mcp-server/src/tool-registry.ts` - Tool dispatch
- `mcp-server/src/context-enrichment.ts` - Auto-enrichment before tool calls
- `mcp-server/src/api-client.ts` - Axios HTTP client
- `rag-api/src/middleware/error-handler.ts` - Express error handler
- `rag-api/src/middleware/async-handler.ts` - Async route wrapper
- `rag-api/src/middleware/auth.ts` - API key auth

### 7. Checked Embedding Service

Read `rag-api/src/services/embedding.ts` and `rag-api/src/config.ts` to verify vector dimensions match.

### 8. Checked API Route Mounting

Read `rag-api/src/server.ts` to verify routes are mounted correctly at `/api` prefix.

### 9. Analyzed Validation Schema Interactions

Checked `recallMemorySchema` and `validateProjectName` middleware interaction. Verified that `projectName` is correctly propagated from header to body to service layer.

### 10. Checked Test Coverage

Read `rag-api/src/__tests__/services/memory.test.ts`. Tests exist for recall but use mocked vectorStore, so they don't catch the real Qdrant interaction issues.

## Root Cause Analysis

### Finding 1 (HIGH): `search()` returns `[]` silently on 404

**Location:** `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts:522-525`

```typescript
if (error.status === 404) {
  return [];
}
```

If the `_agent_memory` collection doesn't exist when `recall()` is called, `search()` silently returns an empty array. No error is logged, no exception is thrown. This perfectly matches the symptom: "empty array, no errors in logs."

**Scenario:** The `remember()` call creates the collection via `upsert()` -> `ensureCollection()`. But if `recall()` is called on a project that has never had `remember()` called, or if the collection was deleted between remember and recall, search returns 404 which becomes `[]`.

**BUT** the `ensure-collections` endpoint creates `_agent_memory` during MCP auto-session start (fire-and-forget). So the collection should exist. Unless the fire-and-forget call failed or hasn't completed yet.

### Finding 2 (HIGH): Named vector search may not properly fall back on all Qdrant configurations

**Location:** `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts:509-540`

The `search()` method tries named vector `{ name: 'dense', vector }` first. For collections with anonymous vectors (like `_agent_memory`), this should fail with a 400 error and fall back to anonymous vector search.

However, the fallback relies on:

1. `error.status === 400` - which depends on the Qdrant JS client properly propagating the HTTP status
2. `error.message?.includes('Bad Request')` - which depends on the HTTP response having a "Bad Request" status text

If either check fails (e.g., due to HTTP/2 which doesn't use status text, or Qdrant client version differences), the error is re-thrown instead of falling back. This would cause an error to propagate, NOT a silent empty array.

The only way this causes a silent empty return is if:

- The named vector search **succeeds** (200) but returns 0 results because no vectors match in a non-existent vector space
- This is theoretically possible if Qdrant silently ignores the vector name and returns empty instead of erroring

### Finding 3 (MEDIUM): Context enrichment uses wrong response key

**Location:** `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts:227`

```typescript
if (memoriesRes?.data?.memories) {  // WRONG - should be .results
```

The `/api/memory/recall-durable` endpoint returns `{ results }` (line 196 in routes/memory.ts), but the enrichment code looks for `.memories`. This means auto-enrichment always sees no memories and returns no context prefix. While this doesn't cause `recall` to return empty, it does cause the context enrichment to silently fail.

### Finding 4 (MEDIUM): `validated` field indexed as `keyword` but stores boolean values

**Location:** `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts:58`

```typescript
{ fieldName: 'validated', type: 'keyword' },
```

The `validated` field is indexed as `keyword` (string type) in Qdrant, but memory objects store it as a boolean (`validated: false` or `validated: true`). Qdrant's keyword index expects string values. This doesn't directly affect `recall()` (which doesn't filter on `validated`), but it affects `getUnvalidatedMemories()` which filters `{ key: 'validated', match: { value: false } }`.

## Recommended Debugging Steps

1. **Check if collection exists:** Call `GET /api/collections?projectName=<name>` or use the Qdrant dashboard to verify `{project}_agent_memory` exists and has points.

2. **Check collection vector config:** Verify whether the collection uses anonymous or named vectors. If it uses named vectors (dense+sparse), the anonymous vector search fallback won't help.

3. **Add logging to search fallback:** Add explicit logging in `vector-store.ts:search()` to log which path is taken (named vs anonymous) and the number of results.

4. **Test with raw Qdrant API:** Bypass the application layer and directly query Qdrant's REST API to verify the collection has searchable data.

5. **Check embedding dimensions:** Verify that the embedding dimensions match the collection's vector size by comparing `config.VECTOR_SIZE` with the Qdrant collection config.

## Recommended Fixes

### Fix 1: Make the search fallback more robust

```typescript
// vector-store.ts search() method
async search(collection, vector, limit, filter, scoreThreshold) {
    // Check if collection uses named or anonymous vectors
    try {
        const info = await this.client.getCollection(collection);
        const vectorConfig = info.config?.params?.vectors;
        const hasNamedVectors = typeof vectorConfig === 'object' && 'dense' in vectorConfig;

        if (hasNamedVectors) {
            return await this.searchNamed(collection, vector, limit, filter, scoreThreshold);
        } else {
            return await this.searchAnonymous(collection, vector, limit, filter, scoreThreshold);
        }
    } catch (error) {
        if (error.status === 404) return [];
        throw error;
    }
}
```

### Fix 2: Add logging to recall for debugging

```typescript
// memory.ts recall() method
async recall(options) {
    const { projectName, query, type = 'all', limit = 5, tag } = options;
    const collectionName = this.getCollectionName(projectName);

    logger.debug('recall start', { projectName, collectionName, query, type, limit });

    const embedding = await embeddingService.embed(query);
    logger.debug('recall embedding computed', { dimensions: embedding.length });

    const results = await vectorStore.search(collectionName, embedding, limit * 2, filter);
    logger.debug('recall search results', { count: results.length });

    // ... rest of the method
}
```

### Fix 3: Fix context enrichment response key

```typescript
// context-enrichment.ts line 227
if (memoriesRes?.data?.results) {  // Fix: use 'results' not 'memories'
    for (const m of memoriesRes.data.results) {
```

### Fix 4: Fix validated index type

```typescript
// vector-store.ts line 58
{ fieldName: 'validated', type: 'bool' },  // Fix: use 'bool' not 'keyword'
```

## Files Analyzed

| File                                                                                                  | Purpose                         |
| ----------------------------------------------------------------------------------------------------- | ------------------------------- |
| `/home/ake/shared-ai-infra/mcp-server/src/tools/memory.ts`                                            | MCP tool definitions for recall |
| `/home/ake/shared-ai-infra/mcp-server/src/index.ts`                                                   | MCP server registration         |
| `/home/ake/shared-ai-infra/mcp-server/src/api-client.ts`                                              | Axios HTTP client               |
| `/home/ake/shared-ai-infra/mcp-server/src/tool-registry.ts`                                           | Tool dispatch                   |
| `/home/ake/shared-ai-infra/mcp-server/src/tool-middleware.ts`                                         | Tool middleware pipeline        |
| `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`                                      | Auto-enrichment                 |
| `/home/ake/shared-ai-infra/rag-api/src/server.ts`                                                     | Express server setup            |
| `/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts`                                              | Memory API routes               |
| `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts`                                            | Memory service (recall logic)   |
| `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts`                                      | Qdrant vector store client      |
| `/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts`                                 | Dual-tier memory governance     |
| `/home/ake/shared-ai-infra/rag-api/src/services/embedding.ts`                                         | Embedding service               |
| `/home/ake/shared-ai-infra/rag-api/src/utils/validation.ts`                                           | Zod validation schemas          |
| `/home/ake/shared-ai-infra/rag-api/src/config.ts`                                                     | Configuration                   |
| `/home/ake/shared-ai-infra/rag-api/src/middleware/error-handler.ts`                                   | Error handler                   |
| `/home/ake/shared-ai-infra/rag-api/src/middleware/async-handler.ts`                                   | Async handler                   |
| `/home/ake/shared-ai-infra/rag-api/src/middleware/auth.ts`                                            | Auth middleware                 |
| `/home/ake/shared-ai-infra/rag-api/src/__tests__/services/memory.test.ts`                             | Memory tests                    |
| `/home/ake/shared-ai-infra/rag-api/package.json`                                                      | Dependencies                    |
| `/home/ake/shared-ai-infra/rag-api/node_modules/@qdrant/js-client-rest/dist/cjs/errors.js`            | Qdrant error classes            |
| `/home/ake/shared-ai-infra/rag-api/node_modules/@qdrant/js-client-rest/dist/cjs/api-client.js`        | Qdrant API client middleware    |
| `/home/ake/shared-ai-infra/rag-api/node_modules/@qdrant/js-client-rest/dist/cjs/qdrant-client.js`     | Qdrant client search method     |
| `/home/ake/shared-ai-infra/rag-api/node_modules/@qdrant/openapi-typescript-fetch/dist/cjs/fetcher.js` | OpenAPI fetch wrapper           |
| `/home/ake/shared-ai-infra/rag-api/node_modules/@qdrant/openapi-typescript-fetch/dist/cjs/types.js`   | ApiError class                  |

## Tool Calls Summary

| Tool  | Count | Purpose                                               |
| ----- | ----- | ----------------------------------------------------- |
| Glob  | 4     | Find recall-related files, check directory structure  |
| Grep  | 11    | Search for patterns, collection names, error handling |
| Read  | 18    | Read source files, test files, library code           |
| Write | 2     | Output files (transcript.md, metrics.json)            |
| Total | 35    |                                                       |
