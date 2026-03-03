# Architecture Analysis: Embedding Caching Strategy

## Current State

### Existing Caching Implementation

The project already has a **mature, multi-level Redis-based embedding cache** implemented in `rag-api/src/services/cache.ts`:

- **L1 (Session)**: TTL 30 min, key `sess:{sessionId}:emb:{hash}` -- hottest, per-session context
- **L2 (Project)**: TTL 1 hour, key `proj:{projectName}:emb:{hash}` -- warm, project-wide
- **L3 (Global)**: TTL 24 hours, key `glob:emb:{hash}` -- cold, cross-project deduplication

The `EmbeddingService` (`rag-api/src/services/embedding.ts`) integrates this via:
- `embedWithSession()` -- uses 3-level Redis cache with promotion (L3 hit promotes to L1+L2)
- `embed()` -- fallback to basic project-level Redis cache
- `embedBatchWithBGE()` -- batch-aware caching: checks cache per text, batches only uncached to BGE-M3

Additional features already implemented:
- **Cache warming** on session start (copies previous session keys, pre-warms recent queries)
- **Cache analytics** per session (L1/L2/L3 hit counts, miss counts, hit rate)
- **Cache pruning** for old sessions

### Relevant ADRs

No existing ADR specifically about caching strategy. Related ADRs:
- **"Use BGE-M3 as primary embedding model"** -- 1024d vectors, ~4KB per embedding serialized
- **"Qdrant as sole vector database with typed collections"** -- mentions Redis for caching

### Relevant Insights (from recalled memories)

- **Performance audit** (Feb 2026): identified "Search cache TTL 3min too low" -- already fixed to 30min
- **Performance audit**: "Serial cache checks in embedding.ts batch operations" -- partially addressed
- **Scalability audit**: "Redis single connection (ioredis default) -- serializes cache ops"
- **Sprint 1 completed**: Increased cache TTL, removed double embedding calls, cached graph expansion

### Tech Debt

No high-impact tech debt currently recorded. However, the scalability audit flagged "Redis single connection" as a limitation.

### Infrastructure

- Redis 7 Alpine, port 6380 (mapped from 6379), with AOF persistence
- No `maxmemory` policy configured (defaults to no limit)
- No Redis connection pooling (single ioredis instance)

---

## Options

### Option A: Expand In-Memory LRU Cache (L0)

Add a process-level in-memory LRU cache as an L0 layer before Redis.

**Implementation:**
- Use `lru-cache` (npm) with configurable max entries and max memory
- Add L0 check before Redis in `getSessionEmbedding()` and `getEmbedding()`
- Entries: ~4KB per 1024d float64 embedding, 1000 entries = ~4MB RAM

**Pros:**
- Zero network latency (in-process, microseconds vs. Redis roundtrip ~0.5-2ms)
- No additional infrastructure dependency
- Simple implementation (~30 lines of code)
- Works even if Redis is down (graceful degradation improves)
- Eliminates serialization/deserialization overhead for hot paths
- Best for single-instance deployment (current architecture)

**Cons:**
- Not shared across rag-api instances (if horizontal scaling later)
- Adds process memory consumption (~4-40MB depending on LRU size)
- Cache coherence issues if multiple instances run concurrently
- Duplicates some of Redis L1 session cache responsibility
- Another TTL/eviction policy to tune and maintain

**Fits patterns:**
- Service Layer (Singleton) -- LRU lives inside `CacheService` or `EmbeddingService`

**Conflicts with:**
- None currently. But may conflict with future horizontal scaling (scalability audit item #8)

---

### Option B: Optimize Redis L2 Cache (Enhance Existing)

Instead of adding a new layer, optimize the existing Redis caching setup.

**Implementation:**
- Enable Redis connection pooling (ioredis `Cluster` or connection pool)
- Configure `maxmemory` + `allkeys-lru` eviction policy
- Use Redis pipelining for batch cache checks (already partially done in stats)
- Parallelize serial cache checks in `embedBatchWithBGE()` (lines 246-270)
- Consider Redis `MGET` for batch lookups instead of sequential `GET`

**Pros:**
- Leverages existing infrastructure and code
- Shared across all instances (future horizontal scaling ready)
- Redis LRU eviction is battle-tested
- Fixes known scalability issue (single connection)
- Pipelining/MGET can reduce batch cache check latency by 5-10x
- No additional process memory usage

**Cons:**
- Still has network roundtrip latency (~0.5-2ms per call)
- Requires Redis tuning knowledge (maxmemory policies)
- Does not eliminate serialization overhead
- Pipelining adds code complexity to batch operations

**Fits patterns:**
- Service Layer (Singleton) -- changes stay in `CacheService`
- Scalability audit recommendations

**Conflicts with:**
- None

---

### Option C: Hybrid -- In-Memory L0 + Redis Optimization (Combined)

Add L0 in-memory LRU AND optimize Redis operations.

**Implementation:**
- L0: Small in-memory LRU (500-1000 entries, ~2-4MB)
- Redis: Connection pooling + MGET for batches + maxmemory config
- L0 serves the hottest embeddings (same query repeated within session)
- Redis handles broader cache (cross-session, cross-project)

**Pros:**
- Best of both worlds: microsecond L0 + shared Redis L1-L3
- L0 absorbs repeated queries (common in context_briefing, search, ask flows)
- Redis optimization fixes scalability issues
- Graceful degradation: L0 works if Redis fails
- Future-proof: L0 for speed, Redis for sharing

**Cons:**
- Most implementation effort (~2-3 hours vs ~1 hour for A or B alone)
- Two eviction policies to tune
- Slightly more complex debugging (which cache served the hit?)
- Need to ensure L0 invalidation when embeddings change (model upgrade)

**Fits patterns:**
- Service Layer (Singleton)
- Multi-level cache pattern (already established with L1/L2/L3)

**Conflicts with:**
- None

---

## Recommendation

**Option C (Hybrid)** is recommended, based on the following reasoning:

1. **The multi-level pattern is already established.** The codebase already uses L1/L2/L3 in Redis. Adding L0 in-memory is a natural extension of this pattern, not a new paradigm.

2. **Known bottleneck exists.** The scalability audit flagged "Redis single connection serializes cache ops" -- Option B's Redis optimization addresses this directly.

3. **Hot-path benefit is significant.** During a typical `context_briefing` call, the same query embedding is computed and then used across multiple search collections. An L0 cache would serve these repeated lookups in microseconds instead of Redis roundtrips.

4. **Low risk.** The in-memory LRU is read-through with Redis as fallback. If L0 misses, behavior is exactly the same as today. No data loss risk.

5. **Current deployment is single-instance.** The scalability audit confirmed "single rag-api in Docker Compose, no load balancer." L0 in-memory is ideal for this topology. When/if horizontal scaling arrives, L0 still provides per-instance benefit while Redis handles cross-instance sharing.

**Suggested parameters:**
- L0 LRU: max 1000 entries, ~4MB, TTL 10 minutes, per-process
- Redis: add `maxmemory 256mb` + `maxmemory-policy allkeys-lru`, switch serial GETs to MGET in batches

---

## Decision Gate

**Waiting for user decision before recording ADR.**

The three options are presented above. Once you confirm your choice (A, B, or C), I will:
1. Record an ADR with the decision, context, and consequences
2. Record a pattern if a new caching pattern emerges
3. Record tech debt if the chosen option introduces known limitations
