## Session Started: 2026-02-26-optimize-vector-store-search

Resumed from previous session `5bb7299c-d483-437a-86e9-b3c0df31310c` (context restored automatically).

### Previous Context
- **Session Summary (2026-02-26)**: Previously worked on optimizing vector-store.ts search performance. Progress was made on key areas of search optimization.
- **Sprint 1 Performance (completed 2026-02-24)**: Parallelized facet retrieval in context-pack.ts (for-loop to Promise.allSettled, saves 200-400ms). Additional performance optimizations were completed.
- **Performance Hotspots Audit (Feb 2026)**: Identified serial facet retrieval in context-pack.ts:100-116, double embedding calls, and other bottlenecks.
- **Qdrant Optimization Opportunities**: Binary Quantization (Qdrant 1.15+) can provide 32x less memory and 40x faster search with 3x oversampling + rescoring.
- **Retrieval Quality Improvements**: Cross-Encoder Reranking identified as Tier 1 high-impact opportunity (+20-35% accuracy, Jina Reranker v2 for code).

### Relevant Code
- `rag-api/src/services/vector-store.ts` -- primary target file, Qdrant client and collection management
- `rag-api/src/services/embedding.ts` -- embedding generation (BGE-M3/Ollama/OpenAI)
- `rag-api/src/services/indexer.ts` -- code chunking and indexing, routes chunks to typed collections
- `rag-api/src/services/context-pack.ts` -- faceted retrieval + LLM rerank + token budget (recently optimized with parallel facets)
- `rag-api/src/services/graph-store.ts` -- graph edges for import/extends dependency expansion

### Active Patterns & ADRs

**Patterns:**
- **Service Layer (Singleton)**: All backend services are singleton classes instantiated at module level. vector-store.ts follows this pattern.
- **Zod Validation Middleware**: All API input validation is centralized in utils/validation.ts using Zod schemas.
- **Parser Registry (Strategy Pattern)**: File parsing uses Strategy pattern via ParserRegistry.

**ADRs:**
- **Qdrant as sole vector database with typed collections** (ACCEPTED): Each project gets namespaced collections ({project}_codebase, _code, _config, _docs, etc.)
- **Zero-downtime reindexing via Qdrant aliases** (ACCEPTED): Reindexing uses alias swap to avoid downtime.
- **Use BGE-M3 as primary embedding model** (ACCEPTED): 1024-dimensional multilingual embeddings.

### Dependencies
- vector-store.ts is consumed by: indexer.ts, context-pack.ts, memory.ts, graph-store.ts, symbol-index.ts
- vector-store.ts depends on: Qdrant JS client, embedding.ts (for vector generation)
- Changes to search methods in vector-store.ts will affect all search routes and the context-pack builder

### Developer Profile
- **Sessions**: 11 sessions, 284 tool calls total
- **Frequent tools**: get_analytics (24x), recall (22x), hybrid_search (21x), context_briefing (16x), get_adrs (15x)
- **Peak hours**: 17:00, 02:00, 22:00
- **Session resumed**: Yes, from previous vector-store optimization session
