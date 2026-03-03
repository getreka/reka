/**
 * Prometheus Metrics - Application monitoring
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// Create custom registry
export const registry = new Registry();

// Collect default Node.js metrics
collectDefaultMetrics({ register: registry });

// ============================================
// HTTP Metrics
// ============================================

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status', 'project'],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path', 'project'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ============================================
// Embedding Metrics
// ============================================

export const embeddingRequestsTotal = new Counter({
  name: 'embedding_requests_total',
  help: 'Total number of embedding requests',
  labelNames: ['provider', 'status'],
  registers: [registry],
});

export const embeddingDuration = new Histogram({
  name: 'embedding_duration_seconds',
  help: 'Duration of embedding generation in seconds',
  labelNames: ['provider'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const embeddingCacheHits = new Counter({
  name: 'embedding_cache_hits_total',
  help: 'Total number of embedding cache hits',
  registers: [registry],
});

export const embeddingCacheMisses = new Counter({
  name: 'embedding_cache_misses_total',
  help: 'Total number of embedding cache misses',
  registers: [registry],
});

// ============================================
// Vector Search Metrics
// ============================================

export const searchRequestsTotal = new Counter({
  name: 'search_requests_total',
  help: 'Total number of vector search requests',
  labelNames: ['collection', 'status'],
  registers: [registry],
});

export const searchDuration = new Histogram({
  name: 'search_duration_seconds',
  help: 'Duration of vector searches in seconds',
  labelNames: ['collection'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const searchResultsCount = new Histogram({
  name: 'search_results_count',
  help: 'Number of results returned per search',
  labelNames: ['collection'],
  buckets: [0, 1, 5, 10, 20, 50],
  registers: [registry],
});

// ============================================
// LLM Metrics
// ============================================

export const llmRequestsTotal = new Counter({
  name: 'llm_requests_total',
  help: 'Total number of LLM requests',
  labelNames: ['provider', 'model', 'status'],
  registers: [registry],
});

export const llmDuration = new Histogram({
  name: 'llm_duration_seconds',
  help: 'Duration of LLM completions in seconds',
  labelNames: ['provider', 'model'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});

export const llmTokensUsed = new Counter({
  name: 'llm_tokens_total',
  help: 'Total tokens used in LLM requests',
  labelNames: ['provider', 'model', 'type'],
  registers: [registry],
});

// ============================================
// Indexing Metrics
// ============================================

export const indexingProgress = new Gauge({
  name: 'indexing_progress',
  help: 'Current indexing progress (0-1)',
  labelNames: ['project'],
  registers: [registry],
});

export const indexingFilesTotal = new Counter({
  name: 'indexing_files_total',
  help: 'Total files indexed',
  labelNames: ['project', 'status'],
  registers: [registry],
});

export const indexingDuration = new Histogram({
  name: 'indexing_duration_seconds',
  help: 'Duration of indexing operations in seconds',
  labelNames: ['project'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [registry],
});

export const indexingChunksByType = new Counter({
  name: 'indexing_chunks_by_type_total',
  help: 'Chunks indexed by type',
  labelNames: ['project', 'chunk_type'],
  registers: [registry],
});

// ============================================
// Circuit Breaker Metrics
// ============================================

export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['name'],
  registers: [registry],
});

export const circuitBreakerTrips = new Counter({
  name: 'circuit_breaker_trips_total',
  help: 'Total number of circuit breaker trips',
  labelNames: ['name'],
  registers: [registry],
});

// ============================================
// Agent Runtime Metrics
// ============================================

export const agentRunsTotal = new Counter({
  name: 'agent_runs_total',
  help: 'Total agent executions',
  labelNames: ['project', 'agent_type', 'status'],
  registers: [registry],
});

export const agentDuration = new Histogram({
  name: 'agent_duration_seconds',
  help: 'Duration of agent executions',
  labelNames: ['project', 'agent_type'],
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const agentIterations = new Histogram({
  name: 'agent_iterations_count',
  help: 'Number of ReAct iterations per agent run',
  labelNames: ['project', 'agent_type'],
  buckets: [1, 2, 3, 5, 8, 10, 15, 20],
  registers: [registry],
});

export const agentActionsTotal = new Counter({
  name: 'agent_actions_total',
  help: 'Total tool actions executed by agents',
  labelNames: ['project', 'agent_type', 'action', 'success'],
  registers: [registry],
});

export const agentTokensUsed = new Counter({
  name: 'agent_tokens_total',
  help: 'Total tokens used by agent LLM calls',
  labelNames: ['project', 'agent_type', 'type'],
  registers: [registry],
});

export const agentFactsExtracted = new Counter({
  name: 'agent_facts_extracted_total',
  help: 'Total facts extracted from agent runs',
  labelNames: ['project', 'agent_type', 'fact_type'],
  registers: [registry],
});

// ============================================
// Context Enrichment Metrics
// ============================================

export const enrichmentTotal = new Counter({
  name: 'enrichment_total',
  help: 'Total context enrichment attempts',
  labelNames: ['project', 'tool', 'result'],
  registers: [registry],
});

export const enrichmentDuration = new Histogram({
  name: 'enrichment_duration_seconds',
  help: 'Duration of context enrichment',
  labelNames: ['project'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const enrichmentRecallCount = new Histogram({
  name: 'enrichment_recall_count',
  help: 'Number of memories recalled per enrichment',
  labelNames: ['project'],
  buckets: [0, 1, 2, 3, 5],
  registers: [registry],
});

// ============================================
// Platform Metrics
// ============================================

export const activeProjects = new Gauge({
  name: 'platform_active_projects',
  help: 'Number of projects with activity in last 24h',
  registers: [registry],
});

export const activeSessions = new Gauge({
  name: 'platform_active_sessions',
  help: 'Currently active sessions across all projects',
  labelNames: ['project'],
  registers: [registry],
});

// ============================================
// Memory Metrics
// ============================================

export const memoryOperationsTotal = new Counter({
  name: 'memory_operations_total',
  help: 'Total memory operations',
  labelNames: ['operation', 'type', 'project'],
  registers: [registry],
});

export const memoryGovernanceTotal = new Counter({
  name: 'memory_governance_total',
  help: 'Memory governance operations',
  labelNames: ['operation', 'tier', 'project'],
  registers: [registry],
});

export const maintenanceDuration = new Histogram({
  name: 'memory_maintenance_duration_seconds',
  help: 'Duration of memory maintenance operations',
  labelNames: ['operation', 'project'],
  buckets: [0.5, 1, 5, 10, 30, 60, 120],
  registers: [registry],
});

// ============================================
// Graph Metrics
// ============================================

export const graphEdgesTotal = new Counter({
  name: 'graph_edges_total',
  help: 'Total graph edges indexed',
  labelNames: ['project', 'edge_type'],
  registers: [registry],
});

export const graphExpansionDuration = new Histogram({
  name: 'graph_expansion_duration_seconds',
  help: 'Duration of graph expansion operations',
  labelNames: ['project'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

// ============================================
// Context Pack Metrics
// ============================================

export const contextPackDuration = new Histogram({
  name: 'context_pack_duration_seconds',
  help: 'Duration of context pack assembly',
  labelNames: ['project'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const contextPackTokens = new Histogram({
  name: 'context_pack_tokens',
  help: 'Tokens in assembled context packs',
  labelNames: ['project'],
  buckets: [500, 1000, 2000, 4000, 8000, 16000],
  registers: [registry],
});

export const rerankDuration = new Histogram({
  name: 'rerank_duration_seconds',
  help: 'Duration of LLM reranking',
  labelNames: [] as string[],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

// ============================================
// Quality Gate Metrics
// ============================================

export const qualityGateResults = new Counter({
  name: 'quality_gate_results_total',
  help: 'Quality gate execution results',
  labelNames: ['gate', 'result', 'project'],
  registers: [registry],
});

export const qualityGateDuration = new Histogram({
  name: 'quality_gate_duration_seconds',
  help: 'Duration of quality gate execution',
  labelNames: ['gate', 'project'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [registry],
});

// ============================================
// Helper Functions
// ============================================

/**
 * Record HTTP request metrics
 */
export function recordHttpRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  project?: string
) {
  const normalizedPath = normalizePath(path);
  httpRequestsTotal.inc({ method, path: normalizedPath, status, project: project || 'unknown' });
  httpRequestDuration.observe({ method, path: normalizedPath, project: project || 'unknown' }, durationMs / 1000);
}

/**
 * Normalize path for metrics (remove IDs)
 */
function normalizePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

/**
 * Get metrics endpoint handler
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

/**
 * Get content type for metrics
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}
