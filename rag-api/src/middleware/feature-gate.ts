/**
 * Feature Gate Middleware
 *
 * Enforces tier-based feature access and usage limits.
 * Checks cached org context (from auth) against tier definitions.
 *
 * Activated when REKA_BILLING_ENABLED=true.
 */

import { Request, Response, NextFunction } from 'express';
import { getUsage } from './metering';

export type Feature =
  | 'cloud_vectors'
  | 'cloud_llm'
  | 'dashboard_basic'
  | 'dashboard_analytics'
  | 'memory_governance_ui'
  | 'team_memory_sharing'
  | 'confluence_integration'
  | 'graph_visualization'
  | 'sso_saml'
  | 'audit_logs'
  | 'webhook_notifications';

export type Tier = 'community' | 'starter' | 'team' | 'enterprise';

interface TierLimits {
  maxProjects: number;
  maxSearchQueries: number;
  maxLlmCalls: number;
  maxMemoryOps: number;
  maxStorageBytes: number;
  features: Set<Feature>;
}

const TIER_DEFINITIONS: Record<Tier, TierLimits> = {
  community: {
    maxProjects: Infinity,
    maxSearchQueries: Infinity,
    maxLlmCalls: Infinity,
    maxMemoryOps: Infinity,
    maxStorageBytes: Infinity,
    features: new Set(), // No cloud features — self-hosted only
  },
  starter: {
    maxProjects: 3,
    maxSearchQueries: 10_000,
    maxLlmCalls: 500,
    maxMemoryOps: 1_000,
    maxStorageBytes: 500 * 1024 * 1024, // 500 MB
    features: new Set([
      'cloud_vectors', 'cloud_llm', 'dashboard_basic',
    ]),
  },
  team: {
    maxProjects: Infinity,
    maxSearchQueries: 50_000,   // per seat
    maxLlmCalls: 2_000,         // per seat
    maxMemoryOps: 5_000,        // per seat
    maxStorageBytes: 2 * 1024 * 1024 * 1024, // 2 GB per project
    features: new Set([
      'cloud_vectors', 'cloud_llm', 'dashboard_basic',
      'dashboard_analytics', 'memory_governance_ui',
      'team_memory_sharing', 'confluence_integration',
      'graph_visualization', 'webhook_notifications',
    ]),
  },
  enterprise: {
    maxProjects: Infinity,
    maxSearchQueries: Infinity,
    maxLlmCalls: Infinity,
    maxMemoryOps: Infinity,
    maxStorageBytes: Infinity,
    features: new Set([
      'cloud_vectors', 'cloud_llm', 'dashboard_basic',
      'dashboard_analytics', 'memory_governance_ui',
      'team_memory_sharing', 'confluence_integration',
      'graph_visualization', 'webhook_notifications',
      'sso_saml', 'audit_logs',
    ]),
  },
};

export function getTierLimits(tier: Tier): TierLimits {
  return TIER_DEFINITIONS[tier] || TIER_DEFINITIONS.community;
}

/**
 * Middleware: require a specific feature for this route.
 */
export function requireFeature(feature: Feature) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.REKA_BILLING_ENABLED !== 'true') return next();

    const tier = ((req as any).authContext?.tier || 'community') as Tier;
    const limits = getTierLimits(tier);

    if (!limits.features.has(feature)) {
      return res.status(403).json({
        error: 'Feature not available',
        code: 'FEATURE_GATED',
        feature,
        currentTier: tier,
        requiredTier: findMinTier(feature),
        upgrade: 'https://reka.dev/billing/upgrade',
      });
    }

    next();
  };
}

/**
 * Middleware: check usage quota for a metric.
 */
export function checkQuota(metric: 'search_queries' | 'llm_calls' | 'memory_operations') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.REKA_BILLING_ENABLED !== 'true') return next();

    const tier = ((req as any).authContext?.tier || 'community') as Tier;
    const limits = getTierLimits(tier);
    const orgId = (req as any).authContext?.orgId || req.headers['x-project-name'] as string || 'unknown';

    const limitMap: Record<string, number> = {
      search_queries: limits.maxSearchQueries,
      llm_calls: limits.maxLlmCalls,
      memory_operations: limits.maxMemoryOps,
    };

    const limit = limitMap[metric];
    if (limit === Infinity) return next();

    try {
      const usage = await getUsage(orgId, metric as any);
      const current = usage[metric] || 0;

      if (current >= limit) {
        // Set warning header even on block
        res.setHeader('X-Reka-Usage-Warning', `${metric}:100%`);
        res.setHeader('X-Reka-Upgrade-Url', 'https://reka.dev/billing/upgrade');

        return res.status(429).json({
          error: 'Quota exceeded',
          code: 'QUOTA_EXCEEDED',
          metric,
          current,
          limit,
          tier,
          upgrade: {
            url: 'https://reka.dev/billing/upgrade',
            message: `Upgrade to increase your ${metric.replace('_', ' ')} limit.`,
          },
        });
      }

      // Warning at 80%
      const pct = (current / limit) * 100;
      if (pct >= 80) {
        res.setHeader('X-Reka-Usage-Warning', `${metric}:${Math.round(pct)}%`);
      }
    } catch {
      // Quota check failure should not block requests
    }

    next();
  };
}

function findMinTier(feature: Feature): Tier {
  for (const tier of ['starter', 'team', 'enterprise'] as Tier[]) {
    if (TIER_DEFINITIONS[tier].features.has(feature)) return tier;
  }
  return 'enterprise';
}
