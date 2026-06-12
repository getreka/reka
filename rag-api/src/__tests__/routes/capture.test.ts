import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Keep generateKey/resetKeys off the real filesystem: keys.json appears absent
// and key persistence becomes a no-op (same approach as middleware/auth.test.ts).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  track: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('../../services/transcript-miner', () => ({
  transcriptMiner: { mine: mocks.mine },
}));

vi.mock('../../services/usage-tracker', () => ({
  usageTracker: { track: mocks.track },
}));

vi.mock('../../services/cache', () => ({
  cacheService: {
    getClient: vi.fn(() => ({ set: mocks.redisSet, del: mocks.redisDel })),
  },
}));

import captureRoutes from '../../routes/capture';
import { authMiddleware, generateKey, resetKeys } from '../../middleware/auth';
import { enforceProjectScope } from '../../middleware/project-scope';
import { errorHandler } from '../../middleware/error-handler';
import { cacheService } from '../../services/cache';

// Full app wiring mirrors server.ts: global json parser (which ignores
// text/plain — proving no conflict with the route-level text parser), then
// auth, then the app-level project-scope guard, then the data router.
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(authMiddleware);
app.use('/api', enforceProjectScope);
app.use('/api', captureRoutes);
app.use(errorHandler);

const MINER_STATS = {
  linesTotal: 12,
  linesUnparseable: 1,
  userTexts: 4,
  candidates: 2,
  ingested: 2,
  skippedBelowThreshold: 0,
  byRule: { explicit_save: 1, correction: 1, repeated_explanation: 0 },
};

const TRANSCRIPT = '{"type":"user","message":{"role":"user","content":"remember this"}}\n';

describe('POST /api/capture/transcript', () => {
  let apiKey: string;

  beforeAll(() => {
    delete process.env.ALLOW_ANONYMOUS;
    resetKeys(); // fs mocked → empty store
    apiKey = generateKey('alpha', 'capture-route-test').key;
  });

  afterAll(() => {
    resetKeys();
  });

  beforeEach(() => {
    mocks.mine.mockReset().mockResolvedValue(MINER_STATS);
    mocks.track.mockReset().mockResolvedValue({ id: 'usage-1' });
    mocks.redisSet.mockReset().mockResolvedValue('OK');
    mocks.redisDel.mockReset().mockResolvedValue(1);
    vi.mocked(cacheService.getClient).mockReturnValue({
      set: mocks.redisSet,
      del: mocks.redisDel,
    } as any);
  });

  it('happy path: mines the transcript and returns the miner stats', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-1')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ captured: true, sessionId: 'sess-1', ...MINER_STATS });
    expect(mocks.mine).toHaveBeenCalledWith({
      transcript: TRANSCRIPT,
      projectName: 'alpha', // resolved from the API key, not from the client
      sessionId: 'sess-1',
    });
    // Idempotency claim: SET NX with the 48h TTL, scoped to the auth project.
    expect(mocks.redisSet).toHaveBeenCalledWith(
      'capture:transcript:alpha:sess-1',
      expect.any(String),
      'EX',
      48 * 60 * 60,
      'NX'
    );
    // Usage row for the ROI capture channel.
    expect(mocks.track).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'alpha',
        sessionId: 'sess-1',
        toolName: 'capture:transcript',
        resultCount: 2,
        metadata: expect.objectContaining({
          candidates: 2,
          ingested: 2,
          skippedBelowThreshold: 0,
        }),
      })
    );
  });

  it('accepts application/x-ndjson', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-nd')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'application/x-ndjson')
      .send(TRANSCRIPT);

    expect(res.status).toBe(200);
    expect(mocks.mine).toHaveBeenCalledOnce();
  });

  it('repeat capture for the same session is skipped (idempotency)', async () => {
    mocks.redisSet.mockResolvedValue(null); // NX claim already held

    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-1')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skipped: true, reason: 'already_captured', sessionId: 'sess-1' });
    expect(mocks.mine).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('rejects anonymous requests when auth is on (401)', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-1')
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(401);
    expect(mocks.mine).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant projectName in the query (403, scope guard tolerates string body)', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-1&projectName=victim')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROJECT_SCOPE_VIOLATION');
    expect(mocks.mine).not.toHaveBeenCalled();
  });

  it('neutralizes a cross-tenant X-Project-Name header (auth pins it to the key project)', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-1')
      .set('X-Api-Key', apiKey)
      .set('X-Project-Name', 'victim')
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(200);
    expect(mocks.mine).toHaveBeenCalledWith(expect.objectContaining({ projectName: 'alpha' }));
    expect(mocks.mine).not.toHaveBeenCalledWith(expect.objectContaining({ projectName: 'victim' }));
  });

  it('rejects a missing sessionId (400)', async () => {
    const res = await request(app)
      .post('/api/capture/transcript')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/);
  });

  it('rejects a malformed sessionId (400)', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=' + encodeURIComponent('../evil'))
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/);
  });

  it('rejects an empty body (400)', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-1')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send('   ');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Transcript body/i);
  });

  it('rejects a JSON body (the transcript must arrive as text)', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-1')
      .set('X-Api-Key', apiKey)
      .send({ transcript: TRANSCRIPT });

    expect(res.status).toBe(400);
    expect(mocks.mine).not.toHaveBeenCalled();
  });

  it('rejects transcripts over the 8mb cap with 413', async () => {
    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-big')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(8 * 1024 * 1024 + 1024));

    expect(res.status).toBe(413);
    expect(mocks.mine).not.toHaveBeenCalled();
  });

  it('returns a safe 500 and releases the idempotency claim when mining fails', async () => {
    mocks.mine.mockRejectedValue(new Error('embedding provider down'));

    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-err')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'Transcript mining failed',
      code: 'CAPTURE_MINING_FAILED',
    });
    // No transcript echo in the error payload.
    expect(JSON.stringify(res.body)).not.toContain('remember this');
    // Retry possible: the NX claim was released.
    expect(mocks.redisDel).toHaveBeenCalledWith('capture:transcript:alpha:sess-err');
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('captures without dedup when Redis is unavailable (best-effort)', async () => {
    vi.mocked(cacheService.getClient).mockReturnValue(null as any);

    const res = await request(app)
      .post('/api/capture/transcript?sessionId=sess-noredis')
      .set('X-Api-Key', apiKey)
      .set('Content-Type', 'text/plain')
      .send(TRANSCRIPT);

    expect(res.status).toBe(200);
    expect(res.body.captured).toBe(true);
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });
});
