import { vi } from 'vitest';

// Mock logger globally to avoid noisy output in tests
vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  },
  createRequestLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock config with test defaults
vi.mock('../config', () => ({
  default: {
    API_PORT: 3100,
    API_HOST: '0.0.0.0',
    QDRANT_URL: 'http://localhost:6333',
    EMBEDDING_PROVIDER: 'bge-m3-server',
    BGE_M3_URL: 'http://localhost:8080',
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_EMBEDDING_MODEL: 'bge-m3',
    LLM_PROVIDER: 'ollama',
    OLLAMA_MODEL: 'qwen2.5:32b',
    OPENAI_MODEL: 'gpt-4-turbo-preview',
    ANTHROPIC_MODEL: 'claude-3-sonnet-20240229',
    VECTOR_SIZE: 1024,
    MEMORY_QUARANTINE_TTL_DAYS: 7,
    MEMORY_DECAY_RATE: 0.10,
    MEMORY_DECAY_MAX: 0.50,
    MEMORY_COMPACTION_THRESHOLD: 0.85,
    MEMORY_COMPACTION_CYCLE_DAYS: 90,
    LOG_LEVEL: 'error',
    AGENT_TIMEOUT: 180000,
  },
}));
