/**
 * Usage Metering Middleware
 *
 * Tracks API usage per organization for billing.
 * Lightweight: uses Redis INCR (async, non-blocking).
 * Flushed to billing system periodically.
 *
 * Activated when REKA_BILLING_ENABLED=true.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { cacheService } from '../services/cache';

export type UsageMetric =
  | 'search_queries'
  | 'llm_calls'
  | 'embedding_generations'
  | 'memory_operations'
  | 'indexed_files';

interface MeteringConfig {
  enabled: boolean;
}

const config: MeteringConfig = {
  enabled: process.env.REKA_BILLING_ENABLED === 'true',
};

// Route → metric mapping
const ROUTE_METRICS: Record<string, UsageMetric> = {
  '/api/search': 'search_queries',
  '/api/ask': 'search_queries',
  '/api/hybrid-search': 'search_queries',
  '/api/memory': 'memory_operations',
  '/api/memory/recall': 'memory_operations',
  '/api/memory/recall-durable': 'memory_operations',
  '/api/memory/recall-ltm': 'memory_operations',
  '/api/memory/promote': 'memory_operations',
  '/api/index': 'indexed_files',
  '/api/index/upload': 'indexed_files',
};

function classifyRequest(path: string): UsageMetric | null {
  for (const [route, metric] of Object.entries(ROUTE_METRICS)) {
    if (path.startsWith(route)) return metric;
  }
  return null;
}

function getOrgKey(req: Request): string {
  // Org comes from auth context or project name as fallback
  return (req as any).authContext?.orgId
    || req.headers['x-org-id'] as string
    || req.headers['x-project-name'] as string
    || 'unknown';
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Record a usage metric. Can be called directly from services
 * for more granular tracking (e.g., token counts from LLM).
 */
export async function recordUsage(
  orgId: string,
  metric: UsageMetric,
  quantity: number = 1
): Promise<void> {
  if (!config.enabled) return;

  try {
    const key = `usage:${orgId}:${metric}:${currentMonth()}`;
    await cacheService.increment(key, quantity);
  } catch {
    // Non-blocking: metering failure should never break requests
  }
}

/**
 * Get current usage for an org/metric.
 */
export async function getUsage(
  orgId: string,
  metric?: UsageMetric
): Promise<Record<string, number>> {
  const month = currentMonth();
  const metrics: UsageMetric[] = metric
    ? [metric]
    : ['search_queries', 'llm_calls', 'embedding_generations', 'memory_operations', 'indexed_files'];

  const result: Record<string, number> = {};
  for (const m of metrics) {
    const key = `usage:${orgId}:${m}:${month}`;
    const val = await cacheService.get<string>(key);
    result[m] = val ? parseInt(val, 10) : 0;
  }
  return result;
}

/**
 * Express middleware: auto-records usage for matched routes.
 */
export function meteringMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!config.enabled) return next();

  // Record after response completes (non-blocking)
  res.on('finish', () => {
    if (res.statusCode >= 400) return; // Don't meter failed requests

    const metric = classifyRequest(req.path);
    if (!metric) return;

    const orgId = getOrgKey(req);
    recordUsage(orgId, metric).catch(() => {});
  });

  next();
}
