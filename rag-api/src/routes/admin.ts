/**
 * Admin Routes - Dead Letter Queue inspection and retry endpoints
 */

import { Router, Request, Response } from 'express';
import { getQueue, type QueueName } from '../events/queues';
import { asyncHandler } from '../middleware/async-handler';
import { logger } from '../utils/logger';

const router = Router();

const ALL_QUEUE_NAMES: QueueName[] = [
  'memory-effects',
  'session-lifecycle',
  'indexing',
  'maintenance',
  'dead-letter',
];

const WORKER_QUEUE_NAMES: QueueName[] = [
  'memory-effects',
  'session-lifecycle',
  'indexing',
  'maintenance',
];

/**
 * GET /api/admin/queues
 * List all queues with their job counts
 */
router.get(
  '/queues',
  asyncHandler(async (req: Request, res: Response) => {
    const stats = await Promise.all(
      ALL_QUEUE_NAMES.map(async (name) => {
        const queue = getQueue(name);
        const counts = await queue.getJobCounts();
        return { name, ...counts };
      })
    );
    res.json({ queues: stats });
  })
);

/**
 * GET /api/admin/dlq
 * List failed jobs across all worker queues
 */
router.get(
  '/dlq',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const allFailed: object[] = [];
    for (const name of WORKER_QUEUE_NAMES) {
      const queue = getQueue(name);
      const failed = await queue.getFailed(0, limit);
      for (const job of failed) {
        allFailed.push({
          id: job.id,
          queue: name,
          name: job.name,
          data: job.data,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
        });
      }
    }

    allFailed.sort((a: any, b: any) => (b.finishedOn || 0) - (a.finishedOn || 0));

    res.json({
      totalFailed: allFailed.length,
      jobs: allFailed.slice(0, limit),
    });
  })
);

/**
 * POST /api/admin/dlq/:queue/:jobId/retry
 * Retry a specific failed job
 */
router.post(
  '/dlq/:queue/:jobId/retry',
  asyncHandler(async (req: Request, res: Response) => {
    const { queue: queueName, jobId } = req.params;

    if (!ALL_QUEUE_NAMES.includes(queueName as QueueName)) {
      return res.status(400).json({ error: `Unknown queue: ${queueName}` });
    }

    const queue = getQueue(queueName as QueueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    await job.retry();
    logger.info('DLQ job retried', { queue: queueName, jobId, jobName: job.name });

    res.json({ success: true, jobId, queue: queueName, name: job.name });
  })
);

/**
 * DELETE /api/admin/dlq/:queue/:jobId
 * Remove a failed job permanently
 */
router.delete(
  '/dlq/:queue/:jobId',
  asyncHandler(async (req: Request, res: Response) => {
    const { queue: queueName, jobId } = req.params;

    if (!ALL_QUEUE_NAMES.includes(queueName as QueueName)) {
      return res.status(400).json({ error: `Unknown queue: ${queueName}` });
    }

    const queue = getQueue(queueName as QueueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    await job.remove();
    logger.info('DLQ job removed', { queue: queueName, jobId });

    res.json({ success: true, jobId, queue: queueName });
  })
);

/**
 * GET /api/admin/actors
 * List active actors with their status
 */
router.get(
  '/actors',
  asyncHandler(async (req: Request, res: Response) => {
    const { actorSystem } = await import('../actors/actor-system');
    const statuses = await actorSystem.getStatus();
    res.json({ actors: statuses });
  })
);

export default router;
