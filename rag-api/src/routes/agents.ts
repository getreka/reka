/**
 * Agent Routes - Run specialized agents and get agent type info.
 */

import { Router, Request, Response } from 'express';
import { agentRuntime } from '../services/agent-runtime';
import { projectProfileService } from '../services/project-profile';
import { asyncHandler } from '../middleware/async-handler';
import { validate, validateProjectName, runAgentSchema } from '../utils/validation';

const router = Router();

/**
 * Run a specialized agent
 * POST /api/agent/run
 */
router.post(
  '/agent/run',
  validateProjectName,
  validate(runAgentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, agentType, task, context, maxIterations, timeout, includeThinking } = req.body;

    const result = await agentRuntime.run({
      projectName,
      agentType,
      task,
      context,
      maxIterations,
      timeout,
    });

    // Strip thinking from steps if not requested
    if (!includeThinking && result.steps) {
      result.steps = result.steps.map(step => {
        const { thinking, ...rest } = step;
        return rest;
      });
    }

    res.json(result);
  })
);

/**
 * List available agent types
 * GET /api/agent/types
 */
router.get(
  '/agent/types',
  asyncHandler(async (_req: Request, res: Response) => {
    const types = agentRuntime.getAgentTypes();
    res.json({ agents: types });
  })
);

// ============================================
// Project Profile
// ============================================

/**
 * Get project profile
 * GET /api/project-profile
 */
router.get(
  '/project-profile',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const profile = await projectProfileService.getProfile(projectName);
    res.json(profile);
  })
);

/**
 * Force refresh project profile
 * POST /api/project-profile/refresh
 */
router.post(
  '/project-profile/refresh',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName } = req.body;
    const profile = await projectProfileService.refreshProfile(projectName);
    res.json(profile);
  })
);

export default router;
