/**
 * Quality Routes - LLM quality monitoring endpoints.
 */

import { Router, Request, Response } from 'express';
import { qualityMetricsGates } from '../services/quality-metrics-gates';
import { asyncHandler } from '../middleware/async-handler';

const router = Router();

/**
 * Get quality report
 * GET /api/quality/report
 */
router.get(
  '/quality/report',
  asyncHandler(async (req: Request, res: Response) => {
    const endpoint = req.query.endpoint as string | undefined;
    const report = await qualityMetricsGates.getReport(endpoint);
    res.json(report);
  })
);

/**
 * Get quality alerts
 * GET /api/quality/alerts
 */
router.get(
  '/quality/alerts',
  asyncHandler(async (_req: Request, res: Response) => {
    const alerts = await qualityMetricsGates.getAlerts();
    res.json({ alerts, count: alerts.length });
  })
);

export default router;
