# Debug Analysis: `recall` Returns Empty Array Despite Existing Memories

## Investigation Summary

Traced the full recall path from MCP tool through middleware to RAG API service and Qdrant vector store. Identified **6 root causes** and **3 contributing factors** that can cause `recall` to return an empty array even when memories exist in the collection, with no errors in logs.

---

## Root Causes

### 1. Collection Name Mismatch: Wrong Qdrant Collection Queried (HIGH)

**File:** `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts` (line 77-79)

```typescript
private getCollectionName(projectName: string): string {
  return `${projectName}_agent_memory`;
}
```

The `recall` method always searches `{project}_agent_memory` (the durable collection). If memories were ingested via the governance pipeline as auto-generated (source starting with `auto_`), they go to `{project}_memory_pending` (quarantine collection) instead. The `recall` tool only searches durable storage, so quarantined memories are invisible.

**How it manifests:** User stores memories via auto-extraction (e.g., `analyze_conversation` with `autoSave: true`), then calls `recall` and gets empty results. No errors because the durable collection exists but is simply empty.

**Evidence:**

- `memory-governance.ts` line 120: `const collectionName = this.getQuarantineCollection(projectName);`
- Auto-generated memories with `source: 'auto_*'` go to quarantine
- `recall` only queries `{project}_agent_memory`

### 2. Adaptive Confidence Threshold Silently Skips Memories (HIGH)

**File:** `/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts` (lines 104-117)

```typescript
const threshold = await this.getAdaptiveThreshold(projectName);
if (confidence !== undefined && confidence < threshold) {
  logger.debug(`Memory below adaptive threshold...`);
  // Return a stub memory without persisting
  return { id: uuidv4(), ... metadata: { skipped: true, reason: 'below_threshold' } };
}
```

When auto-generated memories have a confidence below the adaptive threshold (range: 0.4-0.8, default 0.5), they are **silently skipped** -- a stub Memory object is returned to the caller but nothing is actually persisted to Qdrant. The caller sees a success response with a valid memory object and has no indication the memory was not stored. LOG LEVEL is `debug`, so at default `info` level, this message is invisible.

**How it manifests:** `remember()` appears to succeed (returns a Memory object), but `recall()` returns empty because nothing was persisted.

### 3. `supersededBy` Filter Removes All Results (MEDIUM)

**File:** `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts` (line 171)

```typescript
return results
  .filter(r => !r.payload.supersededBy) // Exclude superseded memories
  .map(r => { ... })
```

When new memories are stored that are highly similar (score > 0.85) to existing ones of the same type, the `detectRelationships` method auto-marks the older memory as "superseded" by setting its `supersededBy` payload field. If all memories in the collection have been superseded by newer ones (which were then themselves superseded, etc.), the post-search filter removes every result.

**How it manifests:** After several iterations of storing similar memories (e.g., updating context notes repeatedly), all memories get marked superseded. The vector search returns results but the `.filter(r => !r.payload.supersededBy)` eliminates them all. No error is thrown -- the method returns an empty array.

### 4. Vector Dimension Mismatch: Silent 404 Returns Empty Array (MEDIUM)

**File:** `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts` (lines 509-540)

```typescript
async search(...): Promise<SearchResult[]> {
  try {
    const namedVector = { name: 'dense', vector } as any;
    const results = await this.client.search(collection, { vector: namedVector, ...searchParams });
    return results.map(r => ({ ... }));
  } catch (error: any) {
    if (error.status === 404) {
      return [];  // Silent empty return
    }
    if (error.message?.includes('Bad Request') || error.status === 400) {
      // Fallback to anonymous vector
      const results = await this.client.search(collection, { vector, ...searchParams });
      return results.map(r => ({ ... }));
    }
    throw error;
  }
}
```

The search method tries named vector (`dense`) first, then falls back to anonymous vector on 400 errors. If the collection was created with anonymous vectors (e.g., via `ensureCollection`) but the search tries a named vector, Qdrant returns a 400 Bad Request, which triggers the fallback -- this works correctly.

**However**, if the collection simply doesn't exist (404), the method silently returns `[]` with no error. If `PROJECT_NAME` changes between sessions, or if the project name has a case mismatch, the collection name won't match and recall silently returns empty.

### 5. Embedding Provider Mismatch: Wrong Vector Space (MEDIUM)

**File:** `/home/ake/shared-ai-infra/rag-api/src/services/embedding.ts`

If the embedding provider changes between when memories were stored and when recall is performed (e.g., switched from `ollama` to `bge-m3-server`, or vice versa), the query embedding will be in a completely different vector space. Cosine similarity between vectors from different embedding models is essentially random, so results will have very low scores.

Combined with the memory aging decay (line 179-188 of memory.ts), old memories with low relevance scores will be ranked poorly and may all fall below any implicit quality threshold.

### 6. Memory Aging Decay Reduces Scores Below Practical Threshold (LOW)

**File:** `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts` (lines 175-189)

```typescript
if (ageMs > THIRTY_DAYS) {
  const validated = r.payload.validated as boolean | undefined;
  const promoted = !!(r.payload.metadata as Record<string, unknown> | undefined)
    ?.promotedAt;
  if (!validated && !promoted) {
    const periodsOld = Math.floor(ageMs / THIRTY_DAYS) - 1;
    const decay = Math.min(0.25, periodsOld * 0.05);
    score *= 1 - decay;
  }
}
```

Unvalidated, non-promoted memories older than 30 days get a score penalty up to 25%. While this doesn't cause empty results by itself, combined with low initial similarity scores, it can push all results to effectively unusable scores. The recall method returns these low-score results anyway (there's no minimum score threshold), but if a downstream consumer has its own threshold, they'd be filtered out.

---

## Contributing Factors

### A. `list` Route Reads `projectName` from `req.body` on GET Request

**File:** `/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts` (line 81)

```typescript
router.get('/memory/list', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;  // <-- GET request body is typically empty
```

GET requests typically don't have a body. The `validateProjectName` middleware does set `req.body.projectName` from the header or query string, so this works in practice, but it's fragile. If the middleware chain order changes, `req.body.projectName` could be undefined, causing the list to query the wrong collection.

### B. Context Enricher Reads Wrong Response Path

**File:** `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts` (lines 227-238)

```typescript
if (memoriesRes?.data?.memories) {  // <-- expects .memories
  for (const m of memoriesRes.data.memories) {
```

But the `/api/memory/recall-durable` route returns `{ results }` (line 73 of memory routes), not `{ memories }`. The enricher reads `memoriesRes.data.memories` which is always `undefined`, so enrichment silently produces no context. This doesn't affect the `recall` MCP tool directly (which correctly reads `response.data.results`), but means context enrichment never works, and the enricher's implicit feedback never fires, which impacts the adaptive confidence threshold computation.

### C. `validated` Field Indexed as `keyword` but Filtered as Boolean

**File:** `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts` (line 58)

```typescript
{ fieldName: 'validated', type: 'keyword' },
```

**File:** `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts` (line 813)

```typescript
{ key: 'validated', match: { value: false } },
```

The `validated` field is indexed as a `keyword` (string) type in Qdrant, but the `getUnvalidatedMemories` method tries to filter it with a boolean value `false`. Qdrant's keyword index expects string matching. This means the filter `{ key: 'validated', match: { value: false } }` may not correctly match points where `validated` is stored as a boolean `false` in the payload. This primarily affects `getUnvalidatedMemories` / `review_memories`, not `recall` directly, but demonstrates a pattern of type mismatches.

---

## Reproduction Scenarios

### Scenario 1: Auto-extracted memories never appear in recall

1. Call `analyze_conversation` with `autoSave: true` -- memories go to quarantine (`_memory_pending`)
2. Call `recall` -- searches only durable (`_agent_memory`), returns empty
3. No errors in logs

### Scenario 2: Adaptive threshold silently drops memories

1. Most auto-memories haven't been promoted (low success rate)
2. Adaptive threshold rises to 0.7-0.8
3. New auto-memories with confidence 0.5-0.6 are silently skipped
4. Debug log message invisible at default `info` level
5. `recall` returns empty because nothing was persisted

### Scenario 3: All memories superseded

1. Store memory A about topic X
2. Store memory B about topic X (very similar, auto-detected as superseding A)
3. Store memory C about topic X (supersedes B)
4. Memory C itself gets superseded by D
5. If D is deleted or in a different collection, all remaining memories (A, B, C) have `supersededBy` set
6. `recall` fetches all 3, filters them all out, returns empty

### Scenario 4: Project name mismatch

1. MCP server starts with `PROJECT_NAME=MyProject`
2. Headers send `X-Project-Name: MyProject`
3. Collection created: `MyProject_agent_memory`
4. Later, MCP server restarts with `PROJECT_NAME=myproject`
5. Searches `myproject_agent_memory` -- collection doesn't exist, 404, returns empty silently

---

## Recommended Fixes

1. **Make `recall` search both durable AND quarantine** (or add a `tier` parameter), so auto-extracted memories are visible
2. **Log at `warn` level** when adaptive threshold skips a memory, not `debug`
3. **Add guard in supersededBy filter** to check if the superseding memory actually exists before filtering out superseded ones
4. **Log at `info` level** when vector search returns 404 (collection not found) in the memory service
5. **Fix context enricher response path**: change `memoriesRes.data.memories` to `memoriesRes.data.results` in `context-enrichment.ts`
6. **Fix `validated` index type**: change from `keyword` to `bool` in vector-store.ts, or use string matching in the filter

---

## Files Examined

| File               | Path                                                                  | Relevance                                                         |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Memory MCP Tool    | `/home/ake/shared-ai-infra/mcp-server/src/tools/memory.ts`            | recall handler (line 80-99)                                       |
| Memory Service     | `/home/ake/shared-ai-infra/rag-api/src/services/memory.ts`            | recall method (line 142-212), supersededBy filter (line 171)      |
| Memory Routes      | `/home/ake/shared-ai-infra/rag-api/src/routes/memory.ts`              | recall endpoint (line 62-74)                                      |
| Memory Governance  | `/home/ake/shared-ai-infra/rag-api/src/services/memory-governance.ts` | quarantine routing (line 91-163), adaptive threshold (line 39-85) |
| Vector Store       | `/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts`      | search method (line 495-540), silent 404 handling                 |
| Context Enrichment | `/home/ake/shared-ai-infra/mcp-server/src/context-enrichment.ts`      | wrong response path (line 227)                                    |
| Validation Schemas | `/home/ake/shared-ai-infra/rag-api/src/utils/validation.ts`           | recallMemorySchema (line 126-132)                                 |
| Tool Middleware    | `/home/ake/shared-ai-infra/mcp-server/src/tool-middleware.ts`         | wrapHandler pipeline                                              |
| API Client         | `/home/ake/shared-ai-infra/mcp-server/src/api-client.ts`              | X-Project-Name header                                             |
| Config             | `/home/ake/shared-ai-infra/rag-api/src/config.ts`                     | VECTOR_SIZE, LOG_LEVEL                                            |
| Embedding Service  | `/home/ake/shared-ai-infra/rag-api/src/services/embedding.ts`         | provider-dependent embeddings                                     |
