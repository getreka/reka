# Architecture Analysis: Embedding Caching -- Redis L2 Cache vs In-Memory LRU

## 1. Existing ADRs Related to Caching

There are **6 ADRs** recorded in the project. **None of them directly address caching strategy.**

The existing ADRs cover:

| # | ADR Title | Relevance to Caching |
|---|-----------|---------------------|
| 1 | Use BGE-M3 as primary embedding model | Defines embedding dimensions (1024d) which affects cache entry size |
| 2 | Zero-downtime reindexing via Qdrant aliases | Tangential -- reindex triggers `invalidateCollection()` on the cache |
| 3 | Context enrichment via before/after hooks | Consumer of cached embeddings via tool dispatch pipeline |
| 4 | AST-based code parsing with ts-morph | No direct relation |
| 5 | Qdrant as sole vector database with typed collections | No direct relation |
| 6 | MCP over stdio with per-project instances | No direct relation |

**Key finding: There is no ADR documenting the current caching architecture or the decision to use Redis as the sole cache backend.** This is a gap -- the multi-level Redis caching system is a significant architectural choice that should be formally documented.

---

## 2. Current Caching Architecture

### Implementation: `rag-api/src/services/cache.ts` (684 lines)

The system uses a **Redis-only, 3-level, session-aware cache** built on `ioredis`:

```
┌──────────────────────────────────────────────────────┐
│  EmbeddingService.embed(text, options?)               │
│                                                      │
│  Session context provided?                           │
│  ├── YES → getSessionEmbedding() [multi-level]       │
│  │   ├── L1: sess:{sessionId}:emb:{hash}  (30 min)  │
│  │   ├── L2: proj:{project}:emb:{hash}    (1 hour)  │
│  │   └── L3: glob:emb:{hash}              (24 hours) │
│  │                                                    │
│  └── NO → getEmbedding() [basic]                     │
│      └── emb:{hash}                        (1 hour)  │
└──────────────────────────────────────────────────────┘
```

**TTL Configuration (constants, not configurable via env):**

| Level | Scope | Key Pattern | TTL |
|-------|-------|-------------|-----|
| L1 | Session | `sess:{sessionId}:emb:{md5}` | 30 minutes |
| L2 | Project | `proj:{project}:emb:{md5}` | 1 hour |
| L3 | Global  | `glob:emb:{md5}` | 24 hours |
| Basic | Flat  | `emb:{md5}` | 1 hour |

**Promotion strategy:** On L2/L3 hit, values are promoted upward (e.g., L3 hit copies to L1 + L2).

**Additional cached data types:**
- Search results: session-aware L1 (30 min) + L2 (30 min)
- Collection info: 30 seconds
- Graph expansions: 5 minutes (`graph-store.ts`)
- Predictive loader prefetches: stored in session search cache
- Session contexts, project profiles, fact extractor audit logs

### Consumers of Embedding Cache

| Service | Usage |
|---------|-------|
| `embedding.ts` | Core embed(), embedWithSession(), embedBatch() |
| `graph-store.ts` | Edge embedding + graph expansion results |
| `predictive-loader.ts` | Prefetch embeddings and search results |
| `indexer.ts` | Collection invalidation after reindex |
| `session-context.ts` | Session metadata caching |
| `project-profile.ts` | Developer profile caching |

### Infrastructure

- Redis 7 Alpine, deployed via Docker on port 6380 (mapped to 6379 internally)
- Persistent storage: `appendonly yes` with a Docker volume (`shared_redis_data`)
- No `maxmemory` or eviction policy configured
- Connection: optional via `REDIS_URL` env var; graceful degradation if Redis is down

### What Does NOT Exist

- **No in-memory LRU cache** anywhere in the embedding path
- **No `lru-cache` package** in dependencies
- **No process-level Map-based embedding cache** (Maps are only used for transient computation state like `indexProgress`, `lastPrefetchTime`, `statsCache`)
- **No L0 (in-process) cache tier** before Redis

---

## 3. Problem Statement

Every embedding cache lookup -- even L1 "session" cache -- requires a **Redis network round-trip**. For a typical search operation:

1. Embed the query text -> 1 Redis GET (L1 check)
2. On L1 miss -> 1 more Redis GET (L2 check)
3. On L2 miss -> 1 more Redis GET (L3 check)
4. On total miss -> HTTP call to BGE-M3 + 3 Redis SETs (write all levels)

Best case (L1 hit): ~0.5-1ms Redis round-trip
Worst case (miss): ~0.5ms * 3 GETs + ~50-200ms BGE-M3 HTTP + 3 SETs

For batch operations (embedBatch), each text gets its own sequential cache check, amplifying latency.

---

## 4. Option A: Add In-Memory LRU as L0 Cache

### Design

Add an in-process LRU cache as "L0" before the Redis layers:

```
L0: In-memory LRU (Node.js Map)  →  ~0.001ms
L1: Redis session cache           →  ~0.5ms
L2: Redis project cache            →  ~0.5ms
L3: Redis global cache             →  ~0.5ms
```

### Implementation Sketch

```typescript
import { LRUCache } from 'lru-cache';

// Each 1024-dim float64 vector = ~8KB raw, ~16KB JSON-serialized
// 500 entries = ~4-8MB RAM
const l0Cache = new LRUCache<string, number[]>({
  max: 500,
  ttl: 5 * 60 * 1000, // 5 minutes
  sizeCalculation: (value) => value.length * 8, // bytes
  maxSize: 50 * 1024 * 1024, // 50MB max
});
```

### Pros

- Eliminates Redis round-trip for hot-path embeddings (500x faster for repeated queries)
- Zero network latency for frequently accessed embeddings within a session
- Simple to implement (~30 lines of code changes in `cache.ts`)
- No infrastructure changes required
- `lru-cache` is a well-maintained, zero-dependency package

### Cons

- Per-process cache: does not share across multiple RAG API instances (currently single-instance, so not an immediate issue)
- Memory growth: 1024-dim vector = ~8KB; 500 cached entries = ~4MB; 2000 entries = ~16MB. Manageable but needs a cap.
- Cache invalidation: L0 does not auto-invalidate when Redis entries are updated by another process (acceptable for embeddings since they are deterministic -- same text always produces same vector)
- Adds complexity to the already 3-level cache system

### Memory Estimation

| L0 Size | Entries | RAM Usage (approx.) |
|---------|---------|---------------------|
| Small | 200 | ~1.6 MB |
| Medium | 500 | ~4 MB |
| Large | 2000 | ~16 MB |
| XL | 5000 | ~40 MB |

For a typical session with ~50-200 unique queries, a 500-entry L0 would cover the hot working set comfortably.

---

## 5. Option B: Increase Redis Cache TTLs / Tune Redis Memory

### What This Means

Instead of adding a new cache layer, optimize the existing Redis-only architecture:

1. Increase L1 TTL from 30 min to 2 hours
2. Increase L2 TTL from 1 hour to 6 hours
3. Increase L3 TTL from 24 hours to 7 days
4. Configure Redis `maxmemory` + `allkeys-lru` eviction policy
5. Add Redis pipelining for batch cache checks

### Pros

- No new dependency or cache layer
- Shared across all processes if horizontally scaled
- Redis already handles eviction with `maxmemory-policy allkeys-lru`
- Longer TTLs mean higher hit rates
- Redis pipelining for batch checks reduces round-trips from N to 1

### Cons

- Still incurs network round-trip latency (~0.5ms per lookup)
- Increasing TTLs increases Redis memory usage
- Does not solve the fundamental "network hop for every embed" problem
- Redis `KEYS` pattern usage in `countKeys()` and `warmSessionCache()` does not scale (should use SCAN)
- No `maxmemory` is currently configured -- risk of unbounded Redis memory growth

---

## 6. Recommendation: Hybrid Approach (L0 In-Memory + Redis Tuning)

The best approach combines both options:

### Phase 1: Add L0 In-Memory LRU (low effort, high impact)

1. Add `lru-cache` dependency to `rag-api`
2. Create L0 tier in `CacheService` with 500-entry / 50MB cap
3. Check L0 before L1 Redis lookup
4. Write-through: on L0 miss + Redis hit, populate L0
5. Session clear also clears L0

### Phase 2: Redis Hardening (medium effort, operational safety)

1. Configure `maxmemory 256mb` and `maxmemory-policy allkeys-lru` in Redis
2. Replace `KEYS` calls with `SCAN` in `countKeys()` and `warmSessionCache()`
3. Add Redis pipeline for batch cache checks in `embedBatchWithBGE()`
4. Make TTL values configurable via environment variables

### Expected Impact

| Metric | Current | After L0 | After Both |
|--------|---------|----------|------------|
| Hot query latency | ~0.5ms (Redis L1) | ~0.001ms (L0 hit) | ~0.001ms |
| Batch 10 texts (all cached) | ~5ms (10 Redis GETs) | ~0.01ms | ~0.01ms |
| Memory overhead | 0 (process) | ~4-8 MB | ~4-8 MB |
| Redis memory safety | Unbounded | Unbounded | Capped at 256MB |
| Multi-instance sharing | Full | L0 per-process | L0 per-process, L1-L3 shared |

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| L0 stale entries | Embeddings are deterministic (same text = same vector), so staleness is not a concern for embeddings. For search results, use shorter L0 TTL (60s). |
| Memory leak in L0 | `lru-cache` enforces `max` entries and `maxSize` bytes. Node.js GC handles evicted entries. |
| Redis unbounded growth | Add `maxmemory` + `allkeys-lru` eviction policy in docker-compose.yml |
| KEYS command blocking | Replace with SCAN iterator in Phase 2 |
| Horizontal scaling | L0 is per-process but acceptable -- embeddings are deterministic, so duplicate computation across instances is rare and harmless |

---

## 8. Gap: Missing ADR

Regardless of which option is chosen, an ADR should be recorded to document:

- **Context:** All embedding cache layers are currently Redis-based with no in-process cache
- **Decision:** Whether to add L0 in-memory LRU, tune Redis, or both
- **Consequences:** Latency improvements, memory trade-offs, operational considerations

This analysis provides the context needed for that ADR decision.

---

## Appendix: Key Files

| File | Role |
|------|------|
| `/home/ake/shared-ai-infra/rag-api/src/services/cache.ts` | CacheService -- Redis multi-level cache (684 lines) |
| `/home/ake/shared-ai-infra/rag-api/src/services/embedding.ts` | EmbeddingService -- cache consumer, multi-provider (351 lines) |
| `/home/ake/shared-ai-infra/rag-api/src/config.ts` | Config with REDIS_URL (104 lines) |
| `/home/ake/shared-ai-infra/rag-api/src/utils/metrics.ts` | Prometheus counters for cache hits/misses |
| `/home/ake/shared-ai-infra/rag-api/src/services/graph-store.ts` | Graph expansion caching (5 min TTL) |
| `/home/ake/shared-ai-infra/rag-api/src/services/predictive-loader.ts` | Predictive prefetch into session cache |
| `/home/ake/shared-ai-infra/docker/docker-compose.yml` | Redis 7 Alpine config (no maxmemory set) |
| `/home/ake/shared-ai-infra/rag-api/src/__tests__/services/embedding.test.ts` | Tests for embedding cache behavior |
