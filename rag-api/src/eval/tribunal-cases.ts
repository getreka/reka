/**
 * Tribunal Eval Cases — test dataset for evaluating debate quality.
 *
 * 3 categories: architecture (5), code approach (5), tech choice (5)
 */

export interface TribunalEvalCase {
  id: string;
  category: 'architecture' | 'code-approach' | 'tech-choice' | 'rag-aware';
  topic: string;
  positions: string[];
  context?: string;
  /** Enable RAG context fetching during debate (for project-specific cases) */
  useCodeContext?: boolean;
  /** Project to search RAG context from (required when useCodeContext=true) */
  projectName?: string;
  expectedQualities: {
    verdictCoversAllPositions: boolean;
    evidenceCited: boolean;
    dissentIncluded: boolean;
    noContradictions: boolean;
    actionable: boolean;
  };
  /** Ground truth best position (optional, for cases with known answers) */
  knownBestPosition?: string;
}

export const EVAL_CASES: TribunalEvalCase[] = [
  // ── Architecture Decisions ──────────────────────────────

  {
    id: 'arch-01',
    category: 'architecture',
    topic: 'Should we use a monolith or microservices for a new SaaS product with 3 developers?',
    positions: ['Monolith', 'Microservices'],
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
    knownBestPosition: 'Monolith',
  },
  {
    id: 'arch-02',
    category: 'architecture',
    topic:
      'For a new analytics service processing 10M events/day, should we use SQL (PostgreSQL) or NoSQL (ClickHouse)?',
    positions: ['PostgreSQL', 'ClickHouse'],
    context:
      'Team has strong PostgreSQL expertise. Events are append-only with timestamp-based queries. Budget is limited.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'arch-03',
    category: 'architecture',
    topic: 'REST vs gRPC for internal service-to-service communication in a Kubernetes cluster',
    positions: ['REST/HTTP', 'gRPC'],
    context:
      'Services are TypeScript (Node.js) and Go. Need streaming for some endpoints. Team knows REST well but not gRPC.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'arch-04',
    category: 'architecture',
    topic:
      'Synchronous request-response vs async event-driven architecture for an order processing system',
    positions: ['Synchronous', 'Event-driven', 'Hybrid (sync for reads, async for writes)'],
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'arch-05',
    category: 'architecture',
    topic: 'Monorepo vs polyrepo for a platform with 5 services, shared libs, and 2 frontend apps',
    positions: ['Monorepo (Turborepo)', 'Polyrepo'],
    context: 'Team of 8 developers. CI/CD via GitHub Actions. Some services deploy independently.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },

  // ── Code Approach ──────────────────────────────────────

  {
    id: 'code-01',
    category: 'code-approach',
    topic: 'Inheritance vs composition for sharing behavior across entity handlers',
    positions: ['Inheritance (abstract base class)', 'Composition (mixins/strategies)'],
    context:
      'TypeScript codebase with 12 entity types sharing validation, serialization, and audit logging.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
    knownBestPosition: 'Composition (mixins/strategies)',
  },
  {
    id: 'code-02',
    category: 'code-approach',
    topic: 'ORM (Prisma) vs raw SQL queries for a data-heavy backend',
    positions: ['Prisma ORM', 'Raw SQL with query builder (Knex)'],
    context:
      'PostgreSQL with complex joins, CTEs, and window functions. Team is full-stack (frontend-heavy).',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'code-03',
    category: 'code-approach',
    topic: 'Throwing exceptions vs returning Result<T, E> for error handling in business logic',
    positions: ['Exceptions (try/catch)', 'Result type (neverthrow/fp-ts)'],
    context:
      'TypeScript Node.js backend. Team is familiar with exceptions. Some new members know Rust.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'code-04',
    category: 'code-approach',
    topic: 'Class-based services vs pure functions for a stateless API layer',
    positions: ['Class-based (singleton services)', 'Pure functions (functional modules)'],
    context: 'Express.js API with dependency injection. Services have no mutable state.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'code-05',
    category: 'code-approach',
    topic:
      'Mutable state with careful mutation vs immutable data structures throughout the codebase',
    positions: ['Mutable (controlled mutation)', 'Immutable (Immer/structuredClone)'],
    context:
      'React + Redux frontend with complex nested state. Performance is critical for large lists.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },

  // ── Tech Choice ────────────────────────────────────────

  {
    id: 'tech-01',
    category: 'tech-choice',
    topic: 'Redis vs Memcached for a session store and API response cache',
    positions: ['Redis', 'Memcached'],
    context:
      'Need TTL support, ~50K req/sec. Some data structures (sorted sets) would be nice but not required.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
    knownBestPosition: 'Redis',
  },

  {
    id: 'tech-02',
    category: 'tech-choice',
    topic: 'Qdrant vs pgvector for a RAG application with 1M+ documents',
    positions: ['Qdrant (dedicated vector DB)', 'pgvector (PostgreSQL extension)'],
    context:
      'Already using PostgreSQL for main data. Need hybrid search (dense + sparse). Budget for infra is moderate.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'tech-03',
    category: 'tech-choice',
    topic: 'Express vs Fastify for a new Node.js API with high throughput requirements',
    positions: ['Express', 'Fastify'],
    context: 'Team knows Express well. Need OpenAPI/Swagger integration. Expect 5K req/sec peak.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'tech-04',
    category: 'tech-choice',
    topic: 'Jest vs Vitest for testing a TypeScript monorepo',
    positions: ['Jest', 'Vitest'],
    context:
      'Monorepo with Vite-based frontend and Node.js backend. Currently no tests. Starting from scratch.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },
  {
    id: 'tech-05',
    category: 'tech-choice',
    topic: 'Docker Compose vs Kubernetes for deploying 5 services in a startup environment',
    positions: ['Docker Compose', 'Kubernetes (k3s)'],
    context:
      'Team of 4, no dedicated DevOps. Running on 2 VPS servers. Need zero-downtime deploys.',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
  },

  // ── RAG-Aware (project-specific decisions) ────────────────

  {
    id: 'rag-01',
    category: 'rag-aware',
    topic:
      'Should the shared RAG infrastructure use BGE-M3 (dedicated embedding server) or Ollama nomic-embed-text for embeddings?',
    positions: ['BGE-M3 (dedicated server, 1024d)', 'Ollama nomic-embed-text (768d)'],
    context:
      'Existing project uses BGE-M3 via TEI server on port 8080. Need multilingual support for Ukrainian+English codebases. Batch embedding for indexing 10K+ files.',
    useCodeContext: true,
    projectName: 'shared-ai-infra',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
    knownBestPosition: 'BGE-M3 (dedicated server, 1024d)',
  },
  {
    id: 'rag-02',
    category: 'rag-aware',
    topic:
      'Single LLM provider vs hybrid routing (Claude for complex tasks + Ollama for utility) in a RAG backend',
    positions: [
      'Single provider (Claude only)',
      'Hybrid routing (Claude complex + Ollama utility)',
      'Single provider (Ollama only)',
    ],
    context:
      'RAG API handles diverse tasks: semantic routing, memory merge, reranking (utility) and code review, agent reasoning, tribunal debates (complex). Cost and latency vary significantly between providers.',
    useCodeContext: true,
    projectName: 'shared-ai-infra',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
    knownBestPosition: 'Hybrid routing (Claude complex + Ollama utility)',
  },
  {
    id: 'rag-03',
    category: 'rag-aware',
    topic:
      'Qdrant (dedicated vector DB) vs pgvector for a multi-project RAG system with 1M+ embeddings and hybrid search',
    positions: ['Qdrant (dedicated vector DB)', 'pgvector (PostgreSQL extension)'],
    context:
      'System serves multiple projects with namespaced collections. Needs: dense+sparse hybrid search, payload filtering, collection-level isolation, HNSW indexing. No existing PostgreSQL in the stack.',
    useCodeContext: true,
    projectName: 'shared-ai-infra',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
    knownBestPosition: 'Qdrant (dedicated vector DB)',
  },
  {
    id: 'rag-04',
    category: 'rag-aware',
    topic:
      'Memory governance: auto-quarantine new memories vs trust-all with manual cleanup for an AI agent memory system',
    positions: [
      'Auto-quarantine (new memories need promotion)',
      'Trust-all (save directly, clean up later)',
    ],
    context:
      'Agent memory stores decisions, insights, patterns, and tech debt. Autonomous agents can create memories. Risk of hallucinated or redundant memories polluting the knowledge base. Need to balance knowledge capture speed vs quality.',
    useCodeContext: true,
    projectName: 'shared-ai-infra',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
    knownBestPosition: 'Auto-quarantine (new memories need promotion)',
  },
  {
    id: 'rag-05',
    category: 'rag-aware',
    topic:
      'MCP server architecture: single shared instance vs per-project instances for multi-project RAG',
    positions: ['Single shared MCP server', 'Per-project MCP instances (stdio)'],
    context:
      'RAG infrastructure serves 3+ projects. Each project needs isolated context (codebase, memory, docs). MCP tools must know which project they operate on. AI assistants (Claude Code) connect via MCP protocol.',
    useCodeContext: true,
    projectName: 'shared-ai-infra',
    expectedQualities: {
      verdictCoversAllPositions: true,
      evidenceCited: true,
      dissentIncluded: true,
      noContradictions: true,
      actionable: true,
    },
    knownBestPosition: 'Per-project MCP instances (stdio)',
  },
];
