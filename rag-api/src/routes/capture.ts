/**
 * Capture Routes - transcript ingestion channel (M5)
 *
 * POST /api/capture/transcript receives a raw Claude Code session transcript
 * (JSONL, text/plain or application/x-ndjson) from the reka-plugin SessionEnd
 * hook and runs the rule-based transcript miner. Candidates enter quarantine
 * through the existing governance gate as source 'auto_transcript'.
 *
 * Mounted with the other data routers, so app-level auth + enforceProjectScope
 * apply. The global express.json ignores text/plain, so the route-level
 * express.text parser does not conflict with it.
 */

import express, { Router, Request, Response, NextFunction } from 'express';
import { transcriptMiner } from '../services/transcript-miner';
import { usageTracker } from '../services/usage-tracker';
import { cacheService } from '../services/cache';
import { asyncHandler } from '../middleware/async-handler';
import { validateProjectName } from '../utils/validation';
import { logger } from '../utils/logger';

const router = Router();

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const IDEMPOTENCY_TTL_SECONDS = 48 * 60 * 60;

function idempotencyKey(projectName: string, sessionId: string): string {
  return `capture:transcript:${projectName}:${sessionId}`;
}

/**
 * express.text() leaves req.body as a raw STRING. validateProjectName assigns
 * req.body.projectName, which throws on a string primitive — so rebuild the
 * body into the canonical {sessionId, transcript} object shape first (the
 * established normalization then applies: X-Project-Name header wins, and
 * authMiddleware has already pinned that header to the key's project).
 */
function normalizeCaptureBody(req: Request, res: Response, next: NextFunction) {
  const transcript = typeof req.body === 'string' ? req.body : '';
  if (!transcript.trim()) {
    return res.status(400).json({
      error: 'Transcript body is required (Content-Type: text/plain or application/x-ndjson)',
    });
  }

  const sessionId = req.query.sessionId;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return res.status(400).json({
      error: 'sessionId query param is required (1-128 chars of [A-Za-z0-9._-])',
    });
  }

  req.body = { sessionId, transcript };
  next();
}

/**
 * Capture a session transcript and mine memory candidates from it.
 * POST /api/capture/transcript?sessionId=...   (body: raw JSONL)
 */
router.post(
  '/capture/transcript',
  express.text({ type: ['text/plain', 'application/x-ndjson'], limit: '8mb' }),
  normalizeCaptureBody,
  validateProjectName,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectName, sessionId, transcript } = req.body as {
      projectName: string;
      sessionId: string;
      transcript: string;
    };

    // Idempotency: one capture per (project, session) per 48h. Redis-less
    // deployments degrade to best-effort (no dedup) rather than failing.
    const redis = cacheService.getClient();
    const key = idempotencyKey(projectName, sessionId);
    if (redis) {
      const acquired = await redis.set(
        key,
        new Date().toISOString(),
        'EX',
        IDEMPOTENCY_TTL_SECONDS,
        'NX'
      );
      if (acquired === null) {
        return res.json({ skipped: true, reason: 'already_captured', sessionId });
      }
    }

    const startTime = Date.now();
    let stats;
    try {
      stats = await transcriptMiner.mine({ transcript, projectName, sessionId });
    } catch (err: any) {
      // Release the idempotency claim so a retry can re-attempt the capture.
      if (redis) await redis.del(key).catch(() => {});
      // Transcripts are private content — the miner guarantees its errors carry
      // no transcript text, and we echo none back; log infra detail only.
      logger.error('Transcript mining failed', {
        project: projectName,
        sessionId,
        error: err?.message || String(err),
      });
      return res.status(500).json({
        error: 'Transcript mining failed',
        code: 'CAPTURE_MINING_FAILED',
      });
    }

    // track() swallows its own failures — never blocks the capture response.
    await usageTracker.track({
      projectName,
      sessionId,
      toolName: 'capture:transcript',
      inputSummary: `transcript capture (${stats.linesTotal} lines, ${stats.userTexts} user turns)`,
      startTime,
      resultCount: stats.ingested,
      success: true,
      metadata: {
        candidates: stats.candidates,
        ingested: stats.ingested,
        skippedBelowThreshold: stats.skippedBelowThreshold,
        byRule: stats.byRule,
      },
    });

    res.json({ captured: true, sessionId, ...stats });
  })
);

export default router;
