/**
 * Quality Routes - LLM quality monitoring endpoints.
 */

import { Router, Request, Response } from 'express';
import { qualityGates } from '../evals/quality-gates';
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
    const report = await qualityGates.getReport(endpoint);
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
    const alerts = await qualityGates.getAlerts();
    res.json({ alerts, count: alerts.length });
  })
);

export default router;
