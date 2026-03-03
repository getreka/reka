# Eval 6: Architecture Decision - Embedding Caching Strategy

## Task
Investigate how embedding caching is organized and what ADRs exist related to caching. Evaluate Redis L2 cache vs. increasing in-memory LRU.

## Tool Calls

### 1. get_adrs (query: "caching embedding Redis LRU")
**Result:** 6 existing ADRs found, **none specifically about caching strategy**:
1. Use BGE-M3 as primary embedding model (accepted)
2. Zero-downtime reindexing via Qdrant aliases (accepted)
3. Context enrichment via before/after hooks in tool dispatch (accepted)
4. Qdrant as sole vector database with typed collections (accepted)
5. AST-based code parsing with ts-morph (accepted)
6. MCP over stdio with per-project instances (accepted)

### 2. recall (query: "caching embeddings Redis LRU cache strategy")
**Result:** 10 memories recalled (46-54% relevance). Key findings:
- **Performance Hotspots Audit (Feb 2026):** Identified search cache TTL 3min as too low (now fixed to 30min), serial cache checks in embedding.ts batch operations, graph expansion not cached (now fixed with 5min Redis TTL)
- **Sprint 1 Performance (completed 2026-02-24):** Cache TTL increased, double embedding calls removed, graph expansion cached in Redis
- **Scalability Limitations:** Single Redis connection (ioredis default) serializes cache ops, no connection pooling
- **Qdrant Optimization:** Binary quantization opportunity for 32x less memory

### 3. hybrid_search (query: "embedding cache Redis LRU memory")
**Result:** Found relevant code in:
- `rag-api/src/services/cache.ts` - CacheService with multi-level strategy
- `rag-api/src/services/embedding.ts` - EmbeddingService with session-aware caching
- `rag-api/src/utils/metrics.ts` - Prometheus counters for cache hits/misses
- `rag-api/src/config.ts` - Redis URL configuration

### 4. Read: /home/ake/shared-ai-infra/rag-api/src/services/cache.ts (684 lines)
**Result:** Full CacheService implementation:
- **Multi-level Redis cache** already implemented:
  - L1: Session cache (30min TTL) - keyed by `sess:{sessionId}:emb:{hash}`
  - L2: Project cache (1 hour TTL) - keyed by `proj:{projectName}:emb:{hash}`
  - L3: Global cache (24 hour TTL) - keyed by `glob:emb:{hash}`
- Promotion strategy: L3 hit promotes to L1+L2, L2 hit promotes to L1
- Session cache warming from previous session or project cache
- Cache analytics per session (hits/misses by level)
- Uses ioredis with lazy connect, max 3 retries
- No in-memory LRU layer at all

### 5. Read: /home/ake/shared-ai-infra/rag-api/src/services/embedding.ts (352 lines)
**Result:** EmbeddingService:
- `embed()` delegates to session-aware or basic caching
- `embedWithSession()` uses 3-level Redis cache
- `embedBatch()` checks cache individually per text, only computes uncached
- Serial cache checks in batch (identified as perf hotspot)
- No in-memory caching layer

### 6. Read: /home/ake/shared-ai-infra/rag-api/src/config.ts (105 lines)
**Result:** Redis configured via `REDIS_URL` env var. No LRU configuration options.

### 7. Grep: LRU/in-memory cache/Map patterns in services
**Result:** Multiple `new Map()` usages found but only for temporary computation (feedback, usage-patterns, session-context), not for embedding caching. No `lru-cache` package dependency.

### 8. Grep: cache references in predictive-loader.ts
**Result:** Predictive loader uses Redis cache for prefetched embeddings and search results. `statsCache` is an in-memory Map but only for prediction statistics, not embeddings.

### 9. Grep: cache references in graph-store.ts
**Result:** Graph expansion cached in Redis with 5min TTL (Sprint 1 fix).

### 10. Grep: redis/lru-cache in package.json
**Result:** `ioredis: ^5.9.2` dependency. No `lru-cache` package.

### 11. Grep: redis in docker-compose.yml
**Result:** Redis 7-alpine on port 6380 (external) / 6379 (internal), with appendonly persistence.

### 12. Read: /home/ake/shared-ai-infra/rag-api/src/utils/metrics.ts (384 lines)
**Result:** Prometheus metrics include `embedding_cache_hits_total` and `embedding_cache_misses_total` counters, but they appear to not be actively incremented in the cache service code.

## Analysis Summary

### Existing ADRs on Caching
**None.** There are 6 ADRs in the system but none cover caching strategy. This is a gap -- the current 3-level Redis caching architecture was implemented without a formal ADR.

### Current Architecture
The system already has a **Redis-only multi-level cache** (L1/L2/L3) with session-aware promotion. There is **no in-memory LRU cache** anywhere in the embedding path.

### Key Findings
1. **Redis is already the L2 cache** -- L1 (session), L2 (project), L3 (global) are all Redis keys with different TTLs
2. **No in-memory caching exists** for embeddings -- every cache check requires a Redis round-trip
3. **Serial cache checks** in batch operations add latency (identified in Feb 2026 audit but not yet fixed)
4. **Single Redis connection** (ioredis default) serializes all cache operations
5. **Each embedding is 1024 floats = ~8KB** in Redis (JSON serialized ~16KB)
6. **Prometheus metrics** for cache hits/misses exist but may not be wired up properly
