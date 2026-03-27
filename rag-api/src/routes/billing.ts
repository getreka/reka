/**
 * Billing & Key Management Routes
 *
 * /api/billing/*  — usage, limits
 * /api/keys/*     — API key CRUD
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { keyManagement } from '../services/key-management';
import { getUsage } from '../middleware/metering';
import { getTierLimits, type Tier } from '../middleware/feature-gate';
import { logger } from '../utils/logger';

const router = Router();

// ─── Usage ─────────────────────────────────────────────────────────

/**
 * GET /api/billing/usage
 * Returns current month usage and limits for the authenticated org.
 */
router.get('/usage', asyncHandler(async (req: Request, res: Response) => {
  const orgId = (req as any).authContext?.orgId
    || req.headers['x-project-name'] as string
    || 'unknown';
  const tier = ((req as any).authContext?.tier || 'community') as Tier;

  const usage = await getUsage(orgId);
  const limits = getTierLimits(tier);

  res.json({
    orgId,
    tier,
    period: new Date().toISOString().slice(0, 7), // YYYY-MM
    usage,
    limits: {
      search_queries: limits.maxSearchQueries,
      llm_calls: limits.maxLlmCalls,
      memory_operations: limits.maxMemoryOps,
      storage_bytes: limits.maxStorageBytes,
    },
    percentUsed: {
      search_queries: limits.maxSearchQueries === Infinity ? 0 : Math.round(((usage.search_queries || 0) / limits.maxSearchQueries) * 100),
      llm_calls: limits.maxLlmCalls === Infinity ? 0 : Math.round(((usage.llm_calls || 0) / limits.maxLlmCalls) * 100),
      memory_operations: limits.maxMemoryOps === Infinity ? 0 : Math.round(((usage.memory_operations || 0) / limits.maxMemoryOps) * 100),
    },
  });
}));

// ─── API Keys ──────────────────────────────────────────────────────

/**
 * POST /api/keys
 * Create a new API key.
 */
router.post('/keys', asyncHandler(async (req: Request, res: Response) => {
  const { name, orgId, tier, type, allowedProjects, permissions, expiresAt } = req.body;

  if (!name || !orgId) {
    return res.status(400).json({ error: 'name and orgId are required' });
  }

  const result = await keyManagement.createKey({
    name,
    orgId,
    tier: tier || 'starter',
    type: type || 'personal',
    allowedProjects,
    permissions,
    expiresAt,
  });

  res.status(201).json({
    message: 'API key created. Save the raw key — it will not be shown again.',
    key: result.rawKey,
    id: result.record.id,
    prefix: result.record.keyPrefix,
    tier: result.record.tier,
    rateLimit: result.record.rateLimit,
  });
}));

/**
 * GET /api/keys
 * List keys for an org.
 */
router.get('/keys', asyncHandler(async (req: Request, res: Response) => {
  const orgId = (req as any).authContext?.orgId
    || req.query.orgId as string
    || req.headers['x-project-name'] as string;

  if (!orgId) {
    return res.status(400).json({ error: 'orgId is required' });
  }

  const keys = await keyManagement.listKeys(orgId);
  res.json({ keys });
}));

/**
 * DELETE /api/keys/:id
 * Revoke an API key.
 */
router.delete('/keys/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const reason = req.body?.reason;

  const revoked = await keyManagement.revokeKey(id, reason);
  if (!revoked) {
    return res.status(404).json({ error: 'Key not found' });
  }

  res.json({ message: 'Key revoked', id });
}));

export default router;
