# Transcript: Architecture Decision - Embedding Cache Strategy

## Task

"Треба вирішити як організувати кешування embeddings — Redis L2 cache чи збільшити in-memory LRU. Які ADR вже є по кешуванню?"

## Step 1: Understand Current State (parallel calls)

### Tool Call 1: get_adrs(query: "caching embeddings Redis LRU")

**Result:** 6 ADRs found, none specifically about caching. Relevant ADRs:

- "Use BGE-M3 as primary embedding model" (accepted) — BGE-M3 on port 8080, 1024d dense vectors
- "Zero-downtime reindexing via Qdrant aliases" (accepted)
- "Context enrichment via before/after hooks in tool dispatch" (accepted)
- "AST-based code parsing with ts-morph" (accepted)
- "Qdrant as sole vector database with typed collections" (accepted)
- "MCP over stdio with per-project instances" (accepted)

**Finding: No existing ADR specifically about embedding caching strategy.**

### Tool Call 2: get_patterns(query: "caching embedding performance")

**Result:** 8 patterns found. Relevant:

- "Service Layer (Singleton)" — all services are singletons, caching lives in CacheService singleton
- "Memory Dual-Tier Governance" — quarantine/durable split with Redis backing
- "Project Isolation via Collection Namespacing" — {project}\_{type} collections in Qdrant

**Finding: No pattern specifically for caching. Cache is embedded within the Service Layer singleton pattern.**

### Tool Call 3: get_tech_debt(impact: "high")

**Result:** No high-impact tech debt found.

### Tool Call 4: analyze_project_structure(deep: true)

**Result:** Standard structure with services in rag-api/src/services/, cache.ts among them. 8 patterns, no structural issues flagged.

## Step 2: Get Architectural Guidance

### Tool Call 5: recall(query: "caching embeddings Redis LRU performance")

**Result:** 5 memories recalled:

1. **Performance Hotspots (Feb 2026 Audit)** — key findings:
   - Search cache TTL was 3min, increased to 30min (-40% embedding calls)
   - Serial cache checks in embedding.ts batch operations need parallelization
   - Graph expansion not cached, adds 200-300ms per context pack
   - Context enrichment has hard 2s timeout, no caching
2. **Retrieval Quality Improvement Opportunities** — mentions HyDE, cross-encoder reranking
3. **Sprint 1 Performance completed 2026-02-24:**
   - Parallelize facet retrieval
   - Increase search cache TTL 3min->30min
   - Remove double embedding calls
   - Cache graph expansion (Redis, 5min TTL)

**Finding: Redis caching is already used for embeddings. TTL was increased from 3min to 30min. No in-memory LRU exists currently.**

### Tool Call 6: search_docs(query: "caching embedding Redis LRU")

**Result:** Found in SPRINT-MEMORY-CLAUDE-INTEGRATION.md:

```
Cache Layers:
Layer 1: Session Cache (Redis, session TTL)
Layer 2: Project Cache (Redis, 1hr TTL)
Layer 3: Cross-Project Cache (Redis, 24hr TTL)
```

**Finding: All 3 cache layers are Redis-based. No in-memory (process) cache layer exists.**

### Tool Call 7: hybrid_search(query: "embedding cache Redis LRU in-memory", limit: 10)

**Result:** Found key files:

- `rag-api/src/services/cache.ts` — CacheService with L1/L2/L3 Redis layers
- `rag-api/src/services/embedding.ts` — EmbeddingService with session-aware caching
- `rag-api/src/utils/metrics.ts` — embeddingCacheHits/Misses counters

### Tool Call 8: suggest_architecture(feature: "Embedding cache layer with Redis L2 and in-memory LRU", type: "service")

**Result:** Suggested following Service Layer (Singleton) pattern. Reference implementations:

- rag-api/src/services/cache.ts
- rag-api/src/services/embedding.ts
- rag-api/src/config.ts

## Step 2 (continued): Deep Code Analysis

### Tool Call 9: Read file rag-api/src/services/cache.ts

**Result:** 684 lines. Full CacheService with:

- Redis-based L1 (Session, 30min), L2 (Project, 1hr), L3 (Global, 24hr)
- getSessionEmbedding() — cascading L1->L2->L3 lookup with promotion
- setSessionEmbedding() — writes to all 3 levels concurrently
- warmSessionCache() — pre-warms L1 from previous session or L2/L3
- Session stats tracking (hits/misses per level)
- Cache analytics (key counts by type, memory usage)

### Tool Call 10: Read file rag-api/src/services/embedding.ts

**Result:** 352 lines. EmbeddingService with:

- embed() — session-aware or basic caching
- embedBatch() — BGE-M3 batch with cache check per item
- embedWithSession() — uses getSessionEmbedding()/setSessionEmbedding()
- No in-memory LRU — all cache goes to Redis

### Tool Call 11: Read file rag-api/src/config.ts

**Result:** REDIS_URL config from env var. No LRU cache config.

### Tool Call 12: Grep for "redis|REDIS" in docker-compose.yml

**Result:** Redis 7 Alpine, port 6380:6379, appendonly enabled, healthcheck.

### Tool Call 13: Grep for "LRU|in.memory.\*cache|lru" in rag-api/src

**Result:** No matches. Confirmed: no in-memory LRU cache exists in the codebase.

### Tool Call 14: Read file rag-api/src/utils/metrics.ts

**Result:** embeddingCacheHits and embeddingCacheMisses Prometheus counters exist but are not wired into the actual cache operations in cache.ts (they exist in metrics.ts but usage is not connected).

### Tool Call 15: Grep for cache in graph-store.ts

**Result:** Graph expansion uses Redis caching with 5min TTL via cacheService.get/set.

### Tool Call 16: search_graph(query: "embedding cache architecture", expandHops: 2)

**Result:** 63 connected files. Key dependency chain:

- embedding.ts -> cache.ts -> ioredis
- embedding.ts -> context-pack.ts
- cache.ts used by: embedding.ts, graph-store.ts, fact-extractor.ts, feedback.ts

### Tool Call 17: Grep for cache in mcp-server/src/tools

**Result:** cache.ts tool module exposes get_cache_stats and warm_cache MCP tools.

## Step 3: Architecture Analysis

(See analysis.md output file for the full analysis)

## Summary of Tool Calls

| #   | Tool                      | Query/Args                                 | Purpose                    |
| --- | ------------------------- | ------------------------------------------ | -------------------------- |
| 1   | get_adrs                  | "caching embeddings Redis LRU"             | Find existing caching ADRs |
| 2   | get_patterns              | "caching embedding performance"            | Find caching patterns      |
| 3   | get_tech_debt             | impact: "high"                             | Check related tech debt    |
| 4   | analyze_project_structure | deep: true                                 | Overall structure review   |
| 5   | recall                    | "caching embeddings Redis LRU performance" | Past session context       |
| 6   | search_docs               | "caching embedding Redis LRU"              | Documentation search       |
| 7   | hybrid_search             | "embedding cache Redis LRU in-memory"      | Code search                |
| 8   | suggest_architecture      | feature: "Embedding cache..."              | Architecture guidance      |
| 9   | Read                      | cache.ts                                   | Deep code review           |
| 10  | Read                      | embedding.ts                               | Deep code review           |
| 11  | Read                      | config.ts                                  | Config review              |
| 12  | Grep                      | redis in docker-compose                    | Infra review               |
| 13  | Grep                      | LRU/in-memory in rag-api                   | Verify no LRU exists       |
| 14  | Read                      | metrics.ts                                 | Check metrics coverage     |
| 15  | Grep                      | cache in graph-store.ts                    | Check graph caching        |
| 16  | search_graph              | "embedding cache architecture"             | Dependency map             |
| 17  | Grep                      | cache in mcp-server/tools                  | MCP tool coverage          |
