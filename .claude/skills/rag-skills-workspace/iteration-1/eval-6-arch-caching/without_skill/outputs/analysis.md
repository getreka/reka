# Embedding Caching Architecture Analysis

## Existing ADRs on Caching

**There are no ADRs related to caching.** The system has 6 accepted ADRs, none of which cover the caching strategy:

| #   | ADR Title                                   | Relevance to Caching                                 |
| --- | ------------------------------------------- | ---------------------------------------------------- |
| 1   | Use BGE-M3 as primary embedding model       | Defines what gets cached (1024d vectors) but not how |
| 2   | Zero-downtime reindexing via Qdrant aliases | Unrelated                                            |
| 3   | Context enrichment via hooks                | Unrelated                                            |
| 4   | Qdrant as sole vector database              | Unrelated                                            |
| 5   | AST-based code parsing with ts-morph        | Unrelated                                            |
| 6   | MCP over stdio with per-project instances   | Unrelated                                            |

**This is an architectural gap.** The 3-level Redis caching strategy was implemented without a formal ADR.

## Current Implementation

File: `/home/ake/shared-ai-infra/rag-api/src/services/cache.ts`

The current system uses **Redis-only multi-level caching**:

```
Request -> L1 (Session, 30min) -> L2 (Project, 1hr) -> L3 (Global, 24hr) -> Compute
```

- **L1 (Session):** `sess:{sessionId}:emb:{md5(text)}` -- TTL 30 min
- **L2 (Project):** `proj:{projectName}:emb:{md5(text)}` -- TTL 1 hour
- **L3 (Global):** `glob:emb:{md5(text)}` -- TTL 24 hours
- **Promotion:** Lower-level hits get promoted to higher levels (L3->L1+L2, L2->L1)
- **Warming:** Session cache can be pre-warmed from previous session or recent queries

**There is no in-memory LRU cache.** Every cache lookup requires a Redis round-trip (~0.5-2ms local, more over network).

## Redis L2 vs In-Memory LRU: Trade-off Analysis

### Option A: Add In-Memory LRU as L0 (Before Redis)

**Pros:**

- Eliminates Redis round-trip for hot embeddings (~0.5-2ms saved per hit)
- Zero network overhead for most-frequent queries
- Process-local, no serialization cost
- Well-suited for session repetition patterns (same queries re-embedded)
- `lru-cache` npm package is mature and battle-tested

**Cons:**

- Memory pressure: each 1024d embedding = ~8KB in memory. 1000 entries = ~8MB, 10K = ~80MB
- Not shared across rag-api instances if horizontally scaled (identified in scalability limitations)
- Cache invalidation complexity: must invalidate both L0 and Redis
- Duplicates data already in Redis L1/L2/L3
- Cold start on process restart (no persistence)

**Recommended L0 configuration:**

```typescript
import { LRUCache } from "lru-cache";
const embeddingL0 = new LRUCache<string, number[]>({
  max: 2000, // ~16MB memory budget
  ttl: 1800 * 1000, // 30 min, matches session TTL
  updateAgeOnGet: true, // Keep hot entries alive
});
```

### Option B: Increase Redis Cache TTLs / Optimize Redis

**Pros:**

- No code changes to caching architecture
- Shared across instances (horizontal scaling ready)
- Already has multi-level promotion logic
- Persistent (Redis AOF)

**Cons:**

- Still pays Redis round-trip on every lookup
- Serial cache checks in batch operations compound latency
- Single Redis connection bottleneck (ioredis default)
- JSON serialization overhead per embedding (~16KB per entry)

**Improvements within current architecture:**

1. Use Redis pipeline for batch cache checks (parallel instead of serial)
2. Enable Redis connection pooling
3. Increase L3 TTL from 24hr to 7 days (embeddings are deterministic)
4. Store embeddings as Redis binary (Buffer) instead of JSON to halve storage
5. Use Redis MGET for batch lookups instead of individual GET calls

### Option C: Hybrid (Recommended)

Add thin in-memory L0 **and** optimize existing Redis layers:

1. **L0 (In-Memory LRU):** 2000 entries (~16MB), 30min TTL, process-local
2. **L1 (Redis Session):** Keep as-is, 30min TTL
3. **L2 (Redis Project):** Keep as-is, 1hr TTL
4. **L3 (Redis Global):** Increase to 7 days (embeddings are deterministic for same text+model)

Plus Redis optimizations:

- Pipeline batch cache checks (`MGET` instead of serial `GET`)
- Connection pooling for Redis (`ioredis` Cluster or multiple connections)
- Binary storage for embeddings (MessagePack instead of JSON)

## Estimated Impact

| Metric                 | Current         | With L0 LRU     | With Redis Optimization | Hybrid                     |
| ---------------------- | --------------- | --------------- | ----------------------- | -------------------------- |
| Cache hit latency      | 0.5-2ms         | <0.1ms (L0 hit) | 0.3-1ms (pipeline)      | <0.1ms (L0), 0.3ms (Redis) |
| Memory overhead        | 0 (app)         | +16MB           | 0                       | +16MB                      |
| Batch 10 lookups       | 5-20ms (serial) | 1-2ms (L0 hits) | 1-3ms (MGET)            | <1ms                       |
| Cross-instance sharing | Yes             | No (L0 only)    | Yes                     | Partial                    |

## Recommendation

**Record an ADR for "Hybrid embedding cache with in-memory L0 + Redis L1-L3"** that:

1. Adds `lru-cache` as L0 in `EmbeddingService` (not `CacheService` -- keep it process-local)
2. Converts batch cache checks from serial to Redis `MGET` pipeline
3. Increases L3 TTL to 7 days
4. Documents the trade-off that L0 is not shared across instances

This gives the best latency improvement with minimal risk, and the ADR documents why the 4-level approach was chosen over pure Redis or pure in-memory solutions.
