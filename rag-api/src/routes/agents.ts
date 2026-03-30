/**
 * Agent Routes - Run specialized agents (ReAct + autonomous) and get agent type info.
 */

import { Router, Request, Response } from 'express';
import { agentRuntime } from '../services/agent-runtime';
import { claudeAgentService } from '../services/claude-agent';
import { projectProfileService } from '../services/project-profile';
import { asyncHandler } from '../middleware/async-handler';
import {
  validate,
  validateProjectName,
  runAgentSchema,
  autonomousAgentSchema,
  stopAutonomousAgentSchema,
  workflowSchema,
} from '../utils/validation';

const router = Router();

// ============================================
// ReAct Agents (in-process, Ollama/Claude)
// ============================================

/**
 * Run a specialized agent
 * POST /api/agent/run
 */
router.post(
  '/agent/run',
  validateProjectName,
  validate(runAgentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, agentType, task, context, maxIterations, timeout, includeThinking } =
      req.body;
    const projectPath = (req.headers['x-project-path'] as string) || undefined;

    const result = await agentRuntime.run({
      projectName,
      agentType,
      task,
      context,
      maxIterations,
      timeout,
      projectPath,
    });

    // Strip thinking from steps if not requested
    if (!includeThinking && result.steps) {
      result.steps = result.steps.map((step) => {
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
    const reactAgents = agentRuntime.getAgentTypes();
    const autonomousAgents = claudeAgentService.getAgentTypes();
    res.json({
      agents: reactAgents,
      autonomous: autonomousAgents,
    });
  })
);

// ============================================
// Autonomous Agents (Claude Agent SDK)
// ============================================

/**
 * Run an autonomous Claude agent
 * POST /api/agent/autonomous
 */
router.post(
  '/agent/autonomous',
  validateProjectName,
  validate(autonomousAgentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      projectName,
      projectPath,
      type,
      task,
      maxTurns,
      maxBudgetUsd,
      model,
      effort,
      includeStreaming,
    } = req.body;

    const result = await claudeAgentService.run({
      projectName,
      projectPath,
      type,
      task,
      maxTurns,
      maxBudgetUsd,
      model,
      effort,
      includeStreaming,
    });

    res.json(result);
  })
);

/**
 * Run a multi-step workflow chaining orchestrators
 * POST /api/agent/workflow
 */
router.post(
  '/agent/workflow',
  validateProjectName,
  validate(workflowSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, projectPath, steps } = req.body;
    const result = await claudeAgentService.runWorkflow({ projectName, projectPath, steps });
    res.json(result);
  })
);

/**
 * Stop a running autonomous agent
 * POST /api/agent/autonomous/stop
 */
router.post(
  '/agent/autonomous/stop',
  validate(stopAutonomousAgentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.body;
    const stopped = claudeAgentService.stop(agentId);
    res.json({ stopped, agentId });
  })
);

/**
 * List running autonomous agents
 * GET /api/agent/autonomous/running
 */
router.get(
  '/agent/autonomous/running',
  asyncHandler(async (_req: Request, res: Response) => {
    const running = claudeAgentService.getRunningAgents();
    res.json({ running, count: running.length });
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
