/**
 * Sensory Buffer & Working Memory Routes
 *
 * Endpoints for the human-memory-inspired sensory buffer (Redis Streams)
 * and working memory (salience-scored slots).
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { validate, validateProjectName, sensoryAppendSchema } from '../utils/validation';
import { sensoryBuffer, computeSalience } from '../services/sensory-buffer';
import { workingMemory } from '../services/working-memory';

const router = Router();

// ── Sensory Buffer ────────────────────────────────────────

/**
 * Append a tool event to the sensory buffer.
 * Called fire-and-forget from MCP tool-middleware.
 * POST /api/sensory/append
 */
router.post('/sensory/append', validateProjectName, validate(sensoryAppendSchema), asyncHandler(async (req: Request, res: Response) => {
  const { projectName, sessionId, toolName, inputSummary, outputSummary, filesTouched, success, durationMs } = req.body;

  const salience = computeSalience(toolName, success);
  const event = {
    toolName,
    inputSummary,
    outputSummary,
    filesTouched,
    success,
    durationMs,
    salience,
    timestamp: new Date().toISOString(),
  };

  // Append to sensory buffer
  await sensoryBuffer.append(projectName, sessionId, event);

  // Attention filter: promote salient events to working memory
  await workingMemory.processEvent(projectName, sessionId, event);

  res.json({ success: true, salience });
}));

/**
 * Read sensory buffer events for a session.
 * GET /api/sensory/:sessionId
 */
router.get('/sensory/:sessionId', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const { sessionId } = req.params;
  const count = parseInt(req.query.count as string || '100', 10);
  const since = req.query.since as string | undefined;

  const events = await sensoryBuffer.read(projectName, sessionId, { count, since });

  res.json({ events, count: events.length });
}));

/**
 * Get sensory buffer statistics.
 * GET /api/sensory/:sessionId/stats
 */
router.get('/sensory/:sessionId/stats', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const { sessionId } = req.params;

  const stats = await sensoryBuffer.getStats(projectName, sessionId);

  res.json(stats);
}));

// ── Working Memory ────────────────────────────────────────

/**
 * Get current working memory state for a session.
 * GET /api/working-memory/:sessionId
 */
router.get('/working-memory/:sessionId', validateProjectName, asyncHandler(async (req: Request, res: Response) => {
  const { projectName } = req.body;
  const { sessionId } = req.params;

  const state = await workingMemory.getState(projectName, sessionId);

  res.json(state);
}));

export default router;
