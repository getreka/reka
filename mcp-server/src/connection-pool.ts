/**
 * Connection pool tuning for RAG API communication.
 * Configures undici global dispatcher to optimize localhost HTTP calls.
 *
 * Env overrides:
 *   MCP_POOL_CONNECTIONS  — max concurrent connections (default 10)
 *   MCP_POOL_KEEPALIVE    — keep-alive timeout ms (default 30000)
 *   MCP_POOL_PIPELINING   — HTTP pipelining depth (default 1; 4 for aggressive)
 */

import { Agent, setGlobalDispatcher } from "undici";

export interface PoolConfig {
  connections?: number;
  keepAliveTimeout?: number;
  pipelining?: number;
}

const DEFAULTS: Required<PoolConfig> = {
  connections: 10,
  keepAliveTimeout: 30_000,
  pipelining: 1,
};

export function configureConnectionPool(config?: PoolConfig): void {
  const merged = { ...DEFAULTS, ...config };

  const agent = new Agent({
    connections: merged.connections,
    keepAliveTimeout: merged.keepAliveTimeout,
    pipelining: merged.pipelining,
  });

  setGlobalDispatcher(agent);
}
