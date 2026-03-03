/**
 * PM Routes - Feature estimation endpoint.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { validate } from '../utils/validation';
import { estimateFeatureSchema } from '../utils/validation';
import { estimateFeature } from '../services/feature-estimator';

const router = Router();

/**
 * Estimate development effort for a feature
 * POST /api/estimate-feature
 */
router.post('/estimate-feature', validate(estimateFeatureSchema), asyncHandler(async (req: Request, res: Response) => {
  const projectName = req.headers['x-project-name'] as string || req.body.projectName;
  const { feature, includeSubtasks } = req.body;

  const result = await estimateFeature({
    projectName,
    feature,
    includeSubtasks,
  });

  res.json(result);
}));

export default router;
