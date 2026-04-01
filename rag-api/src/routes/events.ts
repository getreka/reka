/**
 * SSE Events Route — Server-Sent Events for real-time updates.
 *
 * Endpoints:
 * - GET /api/events          — All events stream
 * - GET /api/events/work     — Work status changes only
 */

import { Router, Request, Response } from 'express';
import { eventBus, type BusEvent } from '../services/event-bus';

const router = Router();

/**
 * SSE stream for all events.
 * GET /api/events
 */
router.get('/events', (req: Request, res: Response) => {
  setupSSE(res);

  const filter = req.query.type as string | undefined;

  const listener = (event: BusEvent) => {
    if (filter && !event.type.startsWith(filter)) return;
    writeSSE(res, event);
  };

  eventBus.on('event', listener);
  req.on('close', () => eventBus.off('event', listener));
});

/**
 * SSE stream for work status changes only.
 * GET /api/events/work
 */
router.get('/events/work', (req: Request, res: Response) => {
  setupSSE(res);

  const projectName = req.query.projectName as string | undefined;

  const listener = (event: BusEvent) => {
    if (projectName && event.data.projectName !== projectName) return;
    writeSSE(res, event);
  };

  for (const type of [
    'work:registered',
    'work:updated',
    'work:completed',
    'work:failed',
    'work:cancelled',
  ] as const) {
    eventBus.on(type, listener);
  }

  req.on('close', () => {
    for (const type of [
      'work:registered',
      'work:updated',
      'work:completed',
      'work:failed',
      'work:cancelled',
    ] as const) {
      eventBus.off(type, listener);
    }
  });
});

function setupSSE(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send initial ping
  res.write('event: ping\ndata: {}\n\n');

  // Keep-alive every 30s
  const keepAlive = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 30_000);

  res.on('close', () => clearInterval(keepAlive));
}

function writeSSE(res: Response, event: BusEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export default router;
