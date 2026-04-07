/**
 * Reka RAG API Configuration
 *
 * Priority: env vars > reka.config.yaml > defaults
 */

import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// Load reka.config.yaml if present
function loadYamlConfig(): Record<string, any> {
  const candidates = [
    process.env.REKA_CONFIG,
    path.join(process.cwd(), 'reka.config.yaml'),
    path.join(process.cwd(), 'reka.config.yml'),
  ].filter(Boolean) as string[];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return (yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, any>) || {};
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

const yamlConfig = loadYamlConfig();

// Helper: env var > yaml path > default
function envOrYaml(envKey: string, yamlPath: string, fallback: string): string {
  if (process.env[envKey]) return process.env[envKey]!;
  const parts = yamlPath.split('.');
  let val: any = yamlConfig;
  for (const p of parts) {
    val = val?.[p];
    if (val === undefined) return fallback;
  }
  return String(val);
}

export interface Config {
  // Server
  API_PORT: number;
  API_HOST: string;

  // Qdrant
  QDRANT_URL: string;
  QDRANT_API_KEY?: string;

  // Embedding
  EMBEDDING_PROVIDER: 'bge-m3-server' | 'ollama' | 'openai';
  BGE_M3_URL: string;
  OLLAMA_URL: string;
  OLLAMA_EMBEDDING_MODEL: string;
  OPENAI_API_KEY?: string;

  // LLM
  LLM_PROVIDER: 'ollama' | 'openai' | 'anthropic';
  OLLAMA_MODEL: string;
  OPENAI_MODEL: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_THINK: boolean;
  CLAUDE_EFFORT: 'low' | 'medium' | 'high' | 'max';

  // Vector
  VECTOR_SIZE: number;

  // Redis (caching)
  REDIS_URL?: string;

  // Ollama Thinking/Reasoning
  OLLAMA_THINK: boolean;
  OLLAMA_THINK_BUDGET: number;

  // Agent Runtime
  AGENT_OLLAMA_MODEL: string;
  AGENT_MAX_ITERATIONS: number;
  AGENT_TIMEOUT: number;

  // Ingestion Pipeline
  SEPARATE_COLLECTIONS: boolean;
  LEGACY_CODEBASE_COLLECTION: boolean;

  // Indexer Parallelism
  INDEXER_FILE_CONCURRENCY: number;
  INDEXER_EMBED_CONCURRENCY: number;

  // Sparse Vectors
  SPARSE_VECTORS_ENABLED: boolean;

  // Qdrant BM25 (replaces BGE-M3 sparse vectors)
  QDRANT_BM25_ENABLED: boolean;

  // Embedding Instructions (Qwen3-Embedding)
  EMBEDDING_INSTRUCTION_ENABLED: boolean;

  // Reranker
  RERANKER_ENABLED: boolean;
  RERANKER_URL: string;
  RERANKER_MIN_RESULTS: number;
  RERANKER_TIMEOUT_MS: number;
  RERANKER_BLEND_WEIGHT: number;

  // RAG-Fusion
  RAG_FUSION_ENABLED: boolean;
  RAG_FUSION_REFORMULATION_COUNT: number;

  // Scheduled Maintenance
  MAINTENANCE_ENABLED: boolean;
  MAINTENANCE_INTERVAL_HOURS: number;
  DEDUP_SIMILARITY_THRESHOLD: number;
  DEDUP_MAX_CLUSTERS: number;
  DEDUP_DELETE_SUPERSEDED: boolean;
  DEDUP_DELETE_GRACE_DAYS: number;

  // Authentication
  API_KEY?: string;

  // Demo mode
  DEMO_MODE: boolean;
  DEMO_DASHBOARD_URL: string;
  DEMO_API_URL: string;

  // Memory Governance
  MEMORY_QUARANTINE_TTL_DAYS: number;
  MEMORY_DECAY_RATE: number;
  MEMORY_DECAY_MAX: number;
  MEMORY_COMPACTION_THRESHOLD: number;
  MEMORY_COMPACTION_CYCLE_DAYS: number;

  // Smart Dispatch Cache
  DISPATCH_CACHE_TTL_DAYS: number;
  DISPATCH_CONFIDENCE_DECAY: number;
  DISPATCH_CONFIDENCE_THRESHOLD: number;

  // Tribunal
  TRIBUNAL_MAX_ROUNDS: number;
  TRIBUNAL_MAX_BUDGET: number;
  TRIBUNAL_JUDGE_COMPLEXITY: 'utility' | 'standard' | 'complex';
  TRIBUNAL_ADVOCATE_COMPLEXITY: 'utility' | 'standard' | 'complex';

  // Human Memory Architecture (Phase 1: Sensory Buffer + Working Memory)
  SENSORY_BUFFER_MAX_LEN: number;
  SENSORY_BUFFER_TTL_HOURS: number;
  WORKING_MEMORY_CAPACITY: number;
  SENSORY_SALIENCE_THRESHOLD: number;

  // Human Memory Architecture (Phase 2: Consolidation + Episodic/Semantic LTM)
  CONSOLIDATION_ENABLED: boolean;
  EPISODIC_BASE_STABILITY_DAYS: number;
  SEMANTIC_BASE_STABILITY_DAYS: number;
  PROCEDURAL_BASE_STABILITY_DAYS: number;
  RECALL_STRENGTHENING_FACTOR: number;
  CONSOLIDATION_TIMEOUT_MS: number;
  CONSOLIDATION_LLM_TIMEOUT_MS: number;

  // Human Memory Architecture (Phase 3: Reconsolidation)
  RECONSOLIDATION_ENABLED: boolean;
  CORECALL_THRESHOLD: number;
  CORECALL_TTL_DAYS: number;
  MAX_TAG_ENRICHMENT_PER_RECALL: number;

  // Human Memory Architecture (Phase 4: Spreading Activation)
  GRAPH_RECALL_ENABLED: boolean;
  SPREADING_ACTIVATION_MAX_HOPS: number;
  SPREADING_ACTIVATION_THRESHOLD: number;
  SPREADING_ACTIVATION_HOP_DECAY: number;
  SPREADING_ACTIVATION_CACHE_TTL: number;

  // Event-Driven Architecture (always on — BullMQ required)
  EVENT_QUEUE_CONCURRENCY: number;
  EVENT_DLQ_MAX_RETRIES: number;

  // LSP Integration
  LSP_ENABLED: boolean;
  LSP_STARTUP_TIMEOUT_MS: number;
  LSP_REQUEST_TIMEOUT_MS: number;
  LSP_IDLE_SHUTDOWN_MS: number;
  LSP_MAX_CONCURRENT: number;

  // Logging
  LOG_LEVEL: string;
}

const config: Config = {
  // Server
  API_PORT: parseInt(process.env.API_PORT || '3100', 10),
  API_HOST: process.env.API_HOST || '127.0.0.1',

  // Qdrant
  QDRANT_URL: process.env.QDRANT_URL || 'http://localhost:6333',
  QDRANT_API_KEY: process.env.QDRANT_API_KEY,

  // Embedding (env > reka.config.yaml > default)
  EMBEDDING_PROVIDER: envOrYaml(
    'EMBEDDING_PROVIDER',
    'models.embeddings.provider',
    'bge-m3-server'
  ) as Config['EMBEDDING_PROVIDER'],
  BGE_M3_URL: envOrYaml('BGE_M3_URL', 'models.embeddings.url', 'http://localhost:8080'),
  OLLAMA_URL: envOrYaml('OLLAMA_URL', 'models.llm.utility.url', 'http://localhost:11434'),
  OLLAMA_EMBEDDING_MODEL: envOrYaml('OLLAMA_EMBEDDING_MODEL', 'models.embeddings.model', 'bge-m3'),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || yamlConfig?.models?.embeddings?.api_key,

  // LLM (env > reka.config.yaml > default)
  LLM_PROVIDER: envOrYaml(
    'LLM_PROVIDER',
    'models.llm.standard.provider',
    'ollama'
  ) as Config['LLM_PROVIDER'],
  OLLAMA_MODEL: envOrYaml('OLLAMA_MODEL', 'models.llm.utility.model', 'qwen3.5:35b'),
  OPENAI_MODEL: envOrYaml('OPENAI_MODEL', 'models.llm.standard.model', 'gpt-4-turbo-preview'),
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || yamlConfig?.models?.llm?.complex?.api_key,
  ANTHROPIC_MODEL: envOrYaml('ANTHROPIC_MODEL', 'models.llm.complex.model', 'claude-sonnet-4-6'),
  ANTHROPIC_THINK: process.env.ANTHROPIC_THINK !== 'false',
  CLAUDE_EFFORT: (process.env.CLAUDE_EFFORT || 'high') as Config['CLAUDE_EFFORT'],

  // Vector size based on embedding provider
  VECTOR_SIZE: parseInt(process.env.VECTOR_SIZE || '1024', 10),

  // Ollama Thinking/Reasoning
  OLLAMA_THINK: process.env.OLLAMA_THINK !== 'false',
  OLLAMA_THINK_BUDGET: parseInt(process.env.OLLAMA_THINK_BUDGET || '8192', 10),

  // Agent Runtime
  AGENT_OLLAMA_MODEL: process.env.AGENT_OLLAMA_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:35b',
  AGENT_MAX_ITERATIONS: parseInt(process.env.AGENT_MAX_ITERATIONS || '8', 10),
  AGENT_TIMEOUT: parseInt(process.env.AGENT_TIMEOUT || '180000', 10),

  // Redis
  REDIS_URL: process.env.REDIS_URL,

  // Event-Driven Architecture (always on — BullMQ required)
  EVENT_QUEUE_CONCURRENCY: parseInt(process.env.EVENT_QUEUE_CONCURRENCY || '3', 10),
  EVENT_DLQ_MAX_RETRIES: parseInt(process.env.EVENT_DLQ_MAX_RETRIES || '3', 10),

  // LSP Integration
  LSP_ENABLED: process.env.LSP_ENABLED === 'true',
  LSP_STARTUP_TIMEOUT_MS: parseInt(process.env.LSP_STARTUP_TIMEOUT_MS || '30000', 10),
  LSP_REQUEST_TIMEOUT_MS: parseInt(process.env.LSP_REQUEST_TIMEOUT_MS || '10000', 10),
  LSP_IDLE_SHUTDOWN_MS: parseInt(process.env.LSP_IDLE_SHUTDOWN_MS || '300000', 10),
  LSP_MAX_CONCURRENT: parseInt(process.env.LSP_MAX_CONCURRENT || '5', 10),

  // Ingestion Pipeline
  SEPARATE_COLLECTIONS: process.env.SEPARATE_COLLECTIONS !== 'false',
  LEGACY_CODEBASE_COLLECTION: process.env.LEGACY_CODEBASE_COLLECTION !== 'false',

  // Indexer Parallelism
  INDEXER_FILE_CONCURRENCY: parseInt(process.env.INDEXER_FILE_CONCURRENCY || '5', 10),
  INDEXER_EMBED_CONCURRENCY: parseInt(process.env.INDEXER_EMBED_CONCURRENCY || '3', 10),

  // Sparse Vectors
  SPARSE_VECTORS_ENABLED: process.env.SPARSE_VECTORS_ENABLED === 'true',

  // Qdrant BM25
  QDRANT_BM25_ENABLED: process.env.QDRANT_BM25_ENABLED === 'true',

  // Embedding Instructions
  EMBEDDING_INSTRUCTION_ENABLED: process.env.EMBEDDING_INSTRUCTION_ENABLED !== 'false',

  // Reranker
  RERANKER_ENABLED: process.env.RERANKER_ENABLED !== 'false',
  RERANKER_URL: process.env.RERANKER_URL || process.env.BGE_M3_URL || 'http://localhost:8080',
  RERANKER_MIN_RESULTS: parseInt(process.env.RERANKER_MIN_RESULTS || '3', 10),
  RERANKER_TIMEOUT_MS: parseInt(process.env.RERANKER_TIMEOUT_MS || '5000', 10),
  RERANKER_BLEND_WEIGHT: parseFloat(process.env.RERANKER_BLEND_WEIGHT || '0.6'),

  // RAG-Fusion
  RAG_FUSION_ENABLED: process.env.RAG_FUSION_ENABLED === 'true',
  RAG_FUSION_REFORMULATION_COUNT: parseInt(process.env.RAG_FUSION_REFORMULATION_COUNT || '3', 10),

  // Scheduled Maintenance
  MAINTENANCE_ENABLED: process.env.MAINTENANCE_ENABLED !== 'false',
  MAINTENANCE_INTERVAL_HOURS: parseInt(process.env.MAINTENANCE_INTERVAL_HOURS || '24', 10),
  DEDUP_SIMILARITY_THRESHOLD: parseFloat(process.env.DEDUP_SIMILARITY_THRESHOLD || '0.88'),
  DEDUP_MAX_CLUSTERS: parseInt(process.env.DEDUP_MAX_CLUSTERS || '50', 10),
  DEDUP_DELETE_SUPERSEDED: process.env.DEDUP_DELETE_SUPERSEDED !== 'false',
  DEDUP_DELETE_GRACE_DAYS: parseInt(process.env.DEDUP_DELETE_GRACE_DAYS || '7', 10),

  // Authentication
  API_KEY: process.env.API_KEY,

  // Demo mode
  DEMO_MODE: process.env.DEMO_MODE === 'true',
  DEMO_DASHBOARD_URL: process.env.DEMO_DASHBOARD_URL || 'https://app.getreka.dev',
  DEMO_API_URL: process.env.DEMO_API_URL || 'https://api.getreka.dev',

  // Memory Governance
  MEMORY_QUARANTINE_TTL_DAYS: parseInt(process.env.MEMORY_QUARANTINE_TTL_DAYS || '7', 10),
  MEMORY_DECAY_RATE: parseFloat(process.env.MEMORY_DECAY_RATE || '0.10'),
  MEMORY_DECAY_MAX: parseFloat(process.env.MEMORY_DECAY_MAX || '0.50'),
  MEMORY_COMPACTION_THRESHOLD: parseFloat(process.env.MEMORY_COMPACTION_THRESHOLD || '0.85'),
  MEMORY_COMPACTION_CYCLE_DAYS: parseInt(process.env.MEMORY_COMPACTION_CYCLE_DAYS || '90', 10),

  // Smart Dispatch Cache
  DISPATCH_CACHE_TTL_DAYS: parseInt(process.env.DISPATCH_CACHE_TTL_DAYS || '30', 10),
  DISPATCH_CONFIDENCE_DECAY: parseFloat(process.env.DISPATCH_CONFIDENCE_DECAY || '0.1'),
  DISPATCH_CONFIDENCE_THRESHOLD: parseFloat(process.env.DISPATCH_CONFIDENCE_THRESHOLD || '0.6'),

  // Tribunal
  TRIBUNAL_MAX_ROUNDS: parseInt(process.env.TRIBUNAL_MAX_ROUNDS || '1', 10),
  TRIBUNAL_MAX_BUDGET: parseFloat(process.env.TRIBUNAL_MAX_BUDGET || '0.50'),
  TRIBUNAL_JUDGE_COMPLEXITY: (process.env.TRIBUNAL_JUDGE_COMPLEXITY ||
    'complex') as Config['TRIBUNAL_JUDGE_COMPLEXITY'],
  TRIBUNAL_ADVOCATE_COMPLEXITY: (process.env.TRIBUNAL_ADVOCATE_COMPLEXITY ||
    'complex') as Config['TRIBUNAL_ADVOCATE_COMPLEXITY'],

  // Human Memory Architecture (Phase 1: Sensory Buffer + Working Memory)
  SENSORY_BUFFER_MAX_LEN: parseInt(process.env.SENSORY_BUFFER_MAX_LEN || '10000', 10),
  SENSORY_BUFFER_TTL_HOURS: parseInt(process.env.SENSORY_BUFFER_TTL_HOURS || '24', 10),
  WORKING_MEMORY_CAPACITY: parseInt(process.env.WORKING_MEMORY_CAPACITY || '20', 10),
  SENSORY_SALIENCE_THRESHOLD: parseFloat(process.env.SENSORY_SALIENCE_THRESHOLD || '0.5'),

  // Human Memory Architecture (Phase 2: Consolidation + Episodic/Semantic LTM)
  CONSOLIDATION_ENABLED: process.env.CONSOLIDATION_ENABLED === 'true',
  EPISODIC_BASE_STABILITY_DAYS: parseInt(process.env.EPISODIC_BASE_STABILITY_DAYS || '7', 10),
  SEMANTIC_BASE_STABILITY_DAYS: parseInt(process.env.SEMANTIC_BASE_STABILITY_DAYS || '90', 10),
  PROCEDURAL_BASE_STABILITY_DAYS: parseInt(process.env.PROCEDURAL_BASE_STABILITY_DAYS || '180', 10),
  RECALL_STRENGTHENING_FACTOR: parseFloat(process.env.RECALL_STRENGTHENING_FACTOR || '1.5'),
  CONSOLIDATION_TIMEOUT_MS: parseInt(process.env.CONSOLIDATION_TIMEOUT_MS || '120000', 10),
  CONSOLIDATION_LLM_TIMEOUT_MS: parseInt(process.env.CONSOLIDATION_LLM_TIMEOUT_MS || '30000', 10),

  // Human Memory Architecture (Phase 3: Reconsolidation)
  RECONSOLIDATION_ENABLED: process.env.RECONSOLIDATION_ENABLED === 'true',
  CORECALL_THRESHOLD: parseInt(process.env.CORECALL_THRESHOLD || '3', 10),
  CORECALL_TTL_DAYS: parseInt(process.env.CORECALL_TTL_DAYS || '30', 10),
  MAX_TAG_ENRICHMENT_PER_RECALL: parseInt(process.env.MAX_TAG_ENRICHMENT_PER_RECALL || '3', 10),

  // Human Memory Architecture (Phase 4: Spreading Activation)
  GRAPH_RECALL_ENABLED: process.env.GRAPH_RECALL_ENABLED === 'true',
  SPREADING_ACTIVATION_MAX_HOPS: parseInt(process.env.SPREADING_ACTIVATION_MAX_HOPS || '2', 10),
  SPREADING_ACTIVATION_THRESHOLD: parseFloat(process.env.SPREADING_ACTIVATION_THRESHOLD || '0.3'),
  SPREADING_ACTIVATION_HOP_DECAY: parseFloat(process.env.SPREADING_ACTIVATION_HOP_DECAY || '0.7'),
  SPREADING_ACTIVATION_CACHE_TTL: parseInt(process.env.SPREADING_ACTIVATION_CACHE_TTL || '300', 10),

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// Startup validation for bounded config values
if (config.MEMORY_DECAY_RATE < 0 || config.MEMORY_DECAY_RATE > 1) {
  throw new Error(`MEMORY_DECAY_RATE must be between 0 and 1, got: ${config.MEMORY_DECAY_RATE}`);
}
if (config.MEMORY_DECAY_MAX < 0 || config.MEMORY_DECAY_MAX > 1) {
  throw new Error(`MEMORY_DECAY_MAX must be between 0 and 1, got: ${config.MEMORY_DECAY_MAX}`);
}
if (config.MEMORY_COMPACTION_THRESHOLD < 0.5 || config.MEMORY_COMPACTION_THRESHOLD > 1) {
  throw new Error(
    `MEMORY_COMPACTION_THRESHOLD must be between 0.5 and 1, got: ${config.MEMORY_COMPACTION_THRESHOLD}`
  );
}

export default config;
