/**
 * Tribunal Routes — Adversarial debate API.
 *
 * Endpoints:
 *   POST /api/tribunal/debate       — sync (blocks until done)
 *   POST /api/tribunal/debate/async — async (returns debateId immediately)
 *   GET  /api/tribunal/debate/:id   — get result by ID
 *   GET  /api/tribunal/history      — debate history (persisted in Qdrant)
 *   GET  /api/tribunal/events/:id   — SSE stream for a specific debate
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { tribunalService } from '../services/tribunal';
import { eventBus, type BusEvent } from '../services/event-bus';
import { asyncHandler } from '../middleware/async-handler';
import {
  validate,
  validateProjectName,
  tribunalDebateSchema,
  tribunalHistorySchema,
} from '../utils/validation';

const router = Router();

/**
 * Run a tribunal debate (sync — blocks until complete)
 * POST /api/tribunal/debate
 */
router.post(
  '/tribunal/debate',
  validateProjectName,
  validate(tribunalDebateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await tribunalService.debate(req.body);
    res.json(result);
  })
);

/**
 * Run a tribunal debate (async — returns debateId immediately)
 * POST /api/tribunal/debate/async
 *
 * Client flow:
 *   1. POST /api/tribunal/debate/async → { debateId, status: 'running' }
 *   2. GET  /api/tribunal/events/:debateId  (SSE stream for live updates)
 *   3. GET  /api/tribunal/debate/:debateId  (poll for final result)
 */
router.post(
  '/tribunal/debate/async',
  validateProjectName,
  validate(tribunalDebateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const debateId = uuidv4();

    // Fire and forget — debate runs in background, stores result at each phase
    tribunalService.debate({ ...req.body, debateId }).catch(() => {
      // Errors handled inside debate() — stored in debateStore + emitted via eventBus
    });

    res.json({
      debateId,
      status: 'running',
      events: `/api/tribunal/events/${debateId}`,
      result: `/api/tribunal/debate/${debateId}`,
    });
  })
);

/**
 * Get debate result by ID
 * GET /api/tribunal/debate/:id
 */
router.get(
  '/tribunal/debate/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const result = tribunalService.getDebate(id);

    if (!result) {
      return res.status(404).json({ error: 'Debate not found or expired' });
    }

    res.json(result);
  })
);

/**
 * Get debate history for a project (persisted in Qdrant)
 * GET /api/tribunal/history?limit=10&topic=optional+search
 */
router.get(
  '/tribunal/history',
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const projectName =
      (req.headers['x-project-name'] as string) || (req.query.projectName as string);
    if (!projectName) {
      return res
        .status(400)
        .json({ error: 'projectName is required (header X-Project-Name or query param)' });
    }

    const parsed = tribunalHistorySchema.parse(req.query);
    const history = await tribunalService.getHistory(projectName, parsed.limit, parsed.topic);
    res.json({ projectName, count: history.length, debates: history });
  })
);

/**
 * SSE stream for a specific debate's events
 * GET /api/tribunal/events/:id
 */
router.get('/tribunal/events/:id', (req: Request, res: Response) => {
  const debateId = req.params.id;

  // Setup SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: ping\ndata: {}\n\n');

  const listener = (event: BusEvent) => {
    if (event.data.debateId !== debateId) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);

    // Close stream when debate is done
    if (event.type === 'tribunal:completed' || event.type === 'tribunal:failed') {
      setTimeout(() => res.end(), 100);
    }
  };

  // Listen to all tribunal events
  for (const type of [
    'tribunal:framing',
    'tribunal:argument',
    'tribunal:rebuttal',
    'tribunal:verdict',
    'tribunal:completed',
    'tribunal:failed',
  ] as const) {
    eventBus.on(type, listener);
  }

  // Cleanup on close
  req.on('close', () => {
    for (const type of [
      'tribunal:framing',
      'tribunal:argument',
      'tribunal:rebuttal',
      'tribunal:verdict',
      'tribunal:completed',
      'tribunal:failed',
    ] as const) {
      eventBus.off(type, listener);
    }
  });

  // Keep-alive
  const keepAlive = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 30_000);
  res.on('close', () => clearInterval(keepAlive));
});

export default router;
