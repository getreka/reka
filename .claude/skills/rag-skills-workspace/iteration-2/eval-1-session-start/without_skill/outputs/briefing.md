# Session Briefing: Vector-Store Search Optimization

## Session Info

- **Session ID:** 5bb7299c-d483-437a-86e9-b3c0df31310c
- **Started:** 2026-02-26T22:03:02.666Z
- **Resumed From:** 023ce663-62b7-4c6c-a097-8f4fe67a4b46
- **Task:** Оптимізація пошуку в vector-store.ts

## Target File

`/home/ake/shared-ai-infra/rag-api/src/services/vector-store.ts` (1314 lines)

## Current Search Methods in vector-store.ts

### 1. `search()` (line 495-540)

- Standard dense vector search
- Tries named vector "dense" first, falls back to anonymous vector
- Parameters: collection, vector, limit, filter, scoreThreshold

### 2. `searchHybridNative()` (line 373-420)

- Native Qdrant Query API with prefetch + RRF fusion (Qdrant v1.10+)
- Combines dense + sparse vectors with server-side RRF
- Falls back to `searchHybridClientSideRRF()` if native API unavailable

### 3. `searchHybridClientSideRRF()` (line 425-490)

- Client-side RRF fallback with k=60
- Runs dense and sparse searches in parallel, merges results
- Uses Reciprocal Rank Fusion scoring

### 4. `searchGroups()` (line 545-583)

- Search with Qdrant searchPointGroups for grouped results
- Falls back to client-side grouping via `groupResultsClientSide()`

### 5. `findClusters()` (line 964-996)

- Uses Qdrant recommend API for similarity clustering

### 6. `findDuplicates()` (line 1001-1068)

- Scrolls collection + searches for near-duplicates above threshold

## Recalled Context: Known Optimization Opportunities

### Performance Hotspots (from Feb 2026 audit)

1. **Search cache TTL 3min** -> increase to 30min, -40% embedding calls
2. **Query learning (autoRewriteQuery)** exists but never called in search path
3. **Graph expansion not cached**, adds 200-300ms per context pack
4. **Context enrichment** has hard 2s timeout, no caching

### Qdrant-Level Optimizations

1. **Binary Quantization** (Qdrant 1.15+): 32x less memory, 40x faster search. Best with 3x oversampling + rescoring
2. **Asymmetric Quantization**: binary storage + scalar queries
3. **HNSW Tuning**: set m=16, ef_construct=200 for code collections (currently defaults)
4. **HNSW Healing** (1.15+): reuses existing graph during optimization
5. **Inline Storage**: quantized vectors in HNSW graph for faster disk-based search
6. Currently only scalar quantization exposed via `enableQuantization()` tool

### Retrieval Quality Improvements (Tier 1 - High Impact)

1. **Cross-Encoder Reranking**: +20-35% accuracy, Jina Reranker v2 (code-specific)
2. **Contextual Retrieval**: -49% failed retrievals (Anthropic technique)
3. **HyDE**: +42pp precision, LLM generates hypothetical answer -> embed -> search
4. **Multi-Query Fusion**: LLM generates 3-5 query variants -> parallel search -> RRF merge

## Architecture Context

### ADRs

- Qdrant is sole vector DB with typed collections (dense 1024d cosine + sparse)
- BGE-M3 primary embedding model (port 8080, batch at `/embed/batch`)
- Zero-downtime reindexing via aliases
- Context enrichment via before/after hooks in tool dispatch
- AST-based code parsing with ts-morph

### Patterns

- Service Layer Singleton pattern (`vectorStore` exported at module bottom)
- Project Isolation via Collection Namespacing (`{project}_{type}`)
- Zod Validation Middleware for routes
- Memory Dual-Tier Governance (quarantine/durable)

### Connected Files (search flow)

- `rag-api/src/routes/search.ts` — search route handler, `expandWithGraph()`, `deduplicateByFile()`
- `rag-api/src/services/context-pack.ts` — ContextPackBuilder with faceted retrieval + LLM rerank
- `rag-api/src/services/embedding.ts` — multi-provider embedding with session-aware caching
- `rag-api/src/services/graph-store.ts` — graph edges in `{project}_graph`
- `rag-api/src/services/query-learning.ts` — auto-rewrite queries (currently unused in search path)
- `rag-api/src/utils/filters.ts` — `buildSearchFilter()` for Qdrant filter construction
- `rag-api/src/config.ts` — VECTOR_SIZE, QDRANT_URL config
- `rag-api/src/services/usage-tracker.ts` — tool usage tracking, findSimilarQueries

## Current Performance Baseline

- **Recall@10:** 91.9%
- **MRR:** 0.846
- **P50 latency:** 46ms

## Suggested Focus Areas for Optimization

1. **Integrate `autoRewriteQuery`** into the search path (exists in query-learning.ts but never called)
2. **Cache graph expansion results** to avoid 200-300ms overhead per context pack
3. **HNSW tuning** (m=16, ef_construct=200) for code collections
4. **Binary quantization** for memory-intensive collections
5. **Cross-encoder reranking** post-search for quality improvement
6. **Search params tuning** — consider `hnsw_ef` override for accuracy vs speed tradeoff

## Developer Profile

- 11 sessions, 283 tool calls
- Most used tools: get_analytics (24x), recall (22x), hybrid_search (21x)
- Peak hours: 17:00, 2:00, 22:00
