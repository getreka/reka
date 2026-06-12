import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, withProject } from '../helpers/app-factory';

const mocks = vi.hoisted(() => ({
  remember: vi.fn(),
  recall: vi.fn(),
  forget: vi.fn(),
  forgetByType: vi.fn(),
  forgetOlderThan: vi.fn(),
  list: vi.fn(),
  updateTodoStatus: vi.fn(),
  getStats: vi.fn(),
  batchRemember: vi.fn(),
  mergeMemories: vi.fn(),
  validateMemory: vi.fn(),
  getUnvalidatedMemories: vi.fn(),
  ingest: vi.fn(),
  promote: vi.fn(),
  listQuarantine: vi.fn(),
  getQuarantineById: vi.fn(),
  deleteFromQuarantine: vi.fn(),
  recallDurable: vi.fn(),
  runMaintenance: vi.fn(),
  getById: vi.fn(),
  analyze: vi.fn(),
  runGates: vi.fn(),
  ltmRecall: vi.fn(),
  logRetrieval: vi.fn(),
}));

vi.mock('../../services/memory', () => ({
  memoryService: {
    remember: mocks.remember,
    recall: mocks.recall,
    forget: mocks.forget,
    forgetByType: mocks.forgetByType,
    forgetOlderThan: mocks.forgetOlderThan,
    list: mocks.list,
    updateTodoStatus: mocks.updateTodoStatus,
    getStats: mocks.getStats,
    batchRemember: mocks.batchRemember,
    mergeMemories: mocks.mergeMemories,
    validateMemory: mocks.validateMemory,
    getUnvalidatedMemories: mocks.getUnvalidatedMemories,
    getById: mocks.getById,
  },
  MemoryType: {},
  TodoStatus: {},
}));

vi.mock('../../services/memory-governance', () => ({
  memoryGovernance: {
    ingest: mocks.ingest,
    promote: mocks.promote,
    listQuarantine: mocks.listQuarantine,
    getQuarantineById: mocks.getQuarantineById,
    deleteFromQuarantine: mocks.deleteFromQuarantine,
    recallDurable: mocks.recallDurable,
    runMaintenance: mocks.runMaintenance,
  },
  PromoteReason: {},
}));

vi.mock('../../services/memory-ltm', () => ({
  memoryLtm: {
    recall: mocks.ltmRecall,
    list: vi.fn(),
    getStats: vi.fn(),
  },
}));

vi.mock('../../services/conversation-analyzer', () => ({
  conversationAnalyzer: { analyze: mocks.analyze },
}));

vi.mock('../../services/quality-gates', () => ({
  qualityGates: { runGates: mocks.runGates },
}));

vi.mock('../../services/graph-store', () => ({
  graphStore: { getBlastRadius: vi.fn().mockResolvedValue({ affectedFiles: [], depth: 0 }) },
}));

vi.mock('../../services/usage-patterns', () => ({
  usagePatterns: { buildDeveloperProfile: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../../services/retrieval-log', () => ({
  retrievalLog: { log: mocks.logRetrieval },
}));

import memoryRoutes from '../../routes/memory';
import { publishEvent } from '../../events/emitter';
import config from '../../config';

const mockedPublishEvent = vi.mocked(publishEvent);

const app = createTestApp({ router: memoryRoutes });

describe('Memory Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /api/memory', () => {
    it('happy path — manual memory stored via memoryService', async () => {
      const fakeMemory = { id: 'mem-1', content: 'test decision', type: 'decision' };
      mocks.remember.mockResolvedValue(fakeMemory);

      const res = await withProject(request(app).post('/api/memory'), 'testproject').send({
        content: 'test decision',
        type: 'decision',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.memory).toEqual(fakeMemory);
      expect(mocks.remember).toHaveBeenCalledOnce();
      expect(mocks.ingest).not.toHaveBeenCalled();
    });

    it('auto-source memory routes through governance ingest', async () => {
      const fakeMemory = { id: 'mem-2', content: 'auto insight', type: 'insight' };
      mocks.ingest.mockResolvedValue(fakeMemory);

      const res = await withProject(request(app).post('/api/memory'), 'testproject').send({
        content: 'auto insight',
        type: 'insight',
        metadata: { source: 'auto_conversation', confidence: 0.8 },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.memory).toEqual(fakeMemory);
      expect(mocks.ingest).toHaveBeenCalledOnce();
      expect(mocks.remember).not.toHaveBeenCalled();
    });

    it('memory-tool writes (source auto_memory_tool, no confidence) ingest with confidence undefined', async () => {
      // M2: the adapter sends NO confidence so governance can never
      // threshold-drop the write — it always quarantines instead.
      const fakeMemory = { id: 'mem-mt', content: 'path write', type: 'note', metadata: {} };
      mocks.ingest.mockResolvedValue(fakeMemory);

      const res = await withProject(request(app).post('/api/memory'), 'testproject').send({
        content: 'path write',
        type: 'note',
        tags: ['mem:path=/memories/auth.md'],
        metadata: { source: 'auto_memory_tool' },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mocks.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'auto_memory_tool',
          confidence: undefined,
        })
      );
      expect(mocks.remember).not.toHaveBeenCalled();
    });

    it('signals non-persistence when governance drops the memory (skipped)', async () => {
      // Governance ingested an auto-memory but dropped it below the adaptive
      // threshold — it set metadata.skipped. The route must NOT report success,
      // so callers using `if (res.success)` don't treat a dropped memory as saved.
      const skippedMemory = {
        id: 'mem-skip',
        content: 'low-confidence auto note',
        type: 'note',
        metadata: { skipped: true },
      };
      mocks.ingest.mockResolvedValue(skippedMemory);

      const res = await withProject(request(app).post('/api/memory'), 'testproject').send({
        content: 'low-confidence auto note',
        type: 'note',
        metadata: { source: 'auto_conversation', confidence: 0.1 },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.persisted).toBe(false);
      expect(res.body.skipped).toBe(true);
      expect(typeof res.body.skipped).toBe('boolean');
      expect(res.body.message).toMatch(/skipped/i);
    });

    it('reports success + skipped:false when governance persists the memory', async () => {
      const persisted = {
        id: 'mem-keep',
        content: 'high-confidence auto note',
        type: 'insight',
        metadata: {},
      };
      mocks.ingest.mockResolvedValue(persisted);

      const res = await withProject(request(app).post('/api/memory'), 'testproject').send({
        content: 'high-confidence auto note',
        type: 'insight',
        metadata: { source: 'auto_conversation', confidence: 0.9 },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.persisted).toBe(true);
      // skipped must always be a real boolean, never undefined.
      expect(res.body.skipped).toBe(false);
      expect(typeof res.body.skipped).toBe('boolean');
    });

    it('missing projectName returns 400', async () => {
      const res = await request(app).post('/api/memory').send({ content: 'something' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/projectName/i);
    });

    it('missing content returns 400 validation error', async () => {
      const res = await withProject(request(app).post('/api/memory'), 'testproject').send({
        type: 'note',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /api/memory/recall', () => {
    it('returns recall results', async () => {
      const fakeResults = [{ memory: { id: 'mem-1', content: 'a decision' }, score: 0.9 }];
      mocks.recall.mockResolvedValue(fakeResults);

      const res = await withProject(request(app).post('/api/memory/recall'), 'testproject').send({
        query: 'some query',
      });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual(fakeResults);
      expect(mocks.recall).toHaveBeenCalledOnce();
    });

    it('empty query returns 400', async () => {
      const res = await withProject(request(app).post('/api/memory/recall'), 'testproject').send({
        query: '',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/memory/recall — retrieval audit log (M3)', () => {
    it('logs delivered results when sessionId is present (surface recall)', async () => {
      const fakeResults = [
        { memory: { id: 'mem-1', content: 'a decision' }, score: 0.9 },
        { memory: { id: 'mem-2', content: 'an insight' }, score: 0.8 },
      ];
      mocks.recall.mockResolvedValue(fakeResults);
      mocks.logRetrieval.mockResolvedValue(undefined);

      const res = await withProject(request(app).post('/api/memory/recall'), 'testproject').send({
        query: 'some query',
        sessionId: 'sess-7',
      });

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(mocks.logRetrieval).toHaveBeenCalledOnce());
      expect(mocks.logRetrieval).toHaveBeenCalledWith({
        projectName: 'testproject',
        sessionId: 'sess-7',
        surface: 'recall',
        memoryIds: ['mem-1', 'mem-2'],
        snippets: ['a decision', 'an insight'],
        query: 'some query',
      });
    });

    it('does NOT log without sessionId (old clients unaffected — zod regression)', async () => {
      mocks.recall.mockResolvedValue([]);

      // Old-client payload: no sessionId, plus an unknown extra field that
      // zod must strip/ignore rather than reject.
      const res = await withProject(request(app).post('/api/memory/recall'), 'testproject').send({
        query: 'some query',
        someFutureField: 'ignored',
      });

      expect(res.status).toBe(200);
      expect(mocks.logRetrieval).not.toHaveBeenCalled();
    });

    it('a throwing retrieval logger must not fail the recall (fire-and-forget)', async () => {
      const fakeResults = [{ memory: { id: 'mem-1', content: 'a decision' }, score: 0.9 }];
      mocks.recall.mockResolvedValue(fakeResults);
      mocks.logRetrieval.mockRejectedValue(new Error('audit log exploded'));

      const res = await withProject(request(app).post('/api/memory/recall'), 'testproject').send({
        query: 'some query',
        sessionId: 'sess-7',
      });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual(fakeResults);
    });

    it('recall-durable logs with surface enrichment when sessionId present', async () => {
      const fakeResults = [{ memory: { id: 'dur-1', content: 'durable fact' }, score: 0.7 }];
      mocks.recallDurable.mockResolvedValue(fakeResults);
      mocks.logRetrieval.mockResolvedValue(undefined);

      const res = await withProject(
        request(app).post('/api/memory/recall-durable'),
        'testproject'
      ).send({ query: 'q', sessionId: 'sess-8' });

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(mocks.logRetrieval).toHaveBeenCalledOnce());
      expect(mocks.logRetrieval).toHaveBeenCalledWith(
        expect.objectContaining({ surface: 'enrichment', sessionId: 'sess-8' })
      );
    });

    it('recall-ltm logs with surface enrichment when sessionId present', async () => {
      mocks.ltmRecall.mockResolvedValue([
        {
          memory: { id: 'ltm-1', content: 'ltm fact', tags: [] },
          score: 0.6,
          retention: 0.9,
          collection: 'semantic',
        },
      ]);
      mocks.logRetrieval.mockResolvedValue(undefined);

      const res = await withProject(
        request(app).post('/api/memory/recall-ltm'),
        'testproject'
      ).send({ query: 'q', sessionId: 'sess-9' });

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(mocks.logRetrieval).toHaveBeenCalledOnce());
      expect(mocks.logRetrieval).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: 'enrichment',
          sessionId: 'sess-9',
          memoryIds: ['ltm-1'],
        })
      );
    });

    it('recall-durable/-ltm do NOT log without sessionId', async () => {
      mocks.recallDurable.mockResolvedValue([]);
      mocks.ltmRecall.mockResolvedValue([]);

      const res1 = await withProject(
        request(app).post('/api/memory/recall-durable'),
        'testproject'
      ).send({ query: 'q' });
      const res2 = await withProject(
        request(app).post('/api/memory/recall-ltm'),
        'testproject'
      ).send({ query: 'q' });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(mocks.logRetrieval).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/memory/recall — LTM strengthen publish scope', () => {
    // Toggle the (globally mocked) config flags so the recall handler runs the
    // LTM merge branch and the reconsolidation publish. Restore after.
    let prevConsolidation: any;
    let prevReconsolidation: any;

    beforeEach(() => {
      prevConsolidation = (config as any).CONSOLIDATION_ENABLED;
      prevReconsolidation = (config as any).RECONSOLIDATION_ENABLED;
      (config as any).CONSOLIDATION_ENABLED = true;
      (config as any).RECONSOLIDATION_ENABLED = true;
      // The outer beforeEach calls vi.resetAllMocks(), which strips the global
      // publishEvent mock's resolved value. The handler does
      // `publishEvent(...).catch(...)`, so it must return a thenable.
      mockedPublishEvent.mockResolvedValue(undefined);
    });

    afterEach(() => {
      (config as any).CONSOLIDATION_ENABLED = prevConsolidation;
      (config as any).RECONSOLIDATION_ENABLED = prevReconsolidation;
    });

    it('publishes memory:recalled ONLY for LTM memories in the final returned set', async () => {
      // Durable returns d1 (also present in LTM → a dup). LTM returns the dup d1,
      // a high-scoring survivor l1, and a low-scoring l2 that gets spliced off at
      // limit=1. The final response is [l1]. The strengthen event must therefore
      // cover ONLY l1 — never the durable dup d1 (its recall was already published
      // by memoryService.recall) and never the spliced-off l2.
      mocks.recall.mockResolvedValue([
        { memory: { id: 'd1', content: 'durable + ltm dup' }, score: 0.9 },
      ]);
      mocks.ltmRecall.mockResolvedValue([
        { memory: { id: 'd1', content: 'durable + ltm dup' }, score: 0.92, collection: 'semantic' },
        { memory: { id: 'l1', content: 'ltm survivor' }, score: 0.95, collection: 'episodic' },
        { memory: { id: 'l2', content: 'ltm spliced off' }, score: 0.2, collection: 'episodic' },
      ]);

      const res = await withProject(request(app).post('/api/memory/recall'), 'testproject').send({
        query: 'recent work',
        limit: 1,
      });

      expect(res.status).toBe(200);
      // Final set is a single highest-scoring LTM survivor.
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].memory.id).toBe('l1');

      // Exactly one strengthen publish, scoped to the returned LTM set only.
      const recalledCalls = mockedPublishEvent.mock.calls.filter((c) => c[0] === 'memory:recalled');
      expect(recalledCalls).toHaveLength(1);
      const payload: any = recalledCalls[0][1];
      expect(payload.memoryIds).toEqual(['l1']);
      expect(payload.resultCount).toBe(1);
      expect(payload.recalledMemories).toHaveLength(1);
      expect(payload.recalledMemories[0].id).toBe('l1');
      // Preserves the true per-result collection label (bug-1 fix).
      expect(payload.recalledMemories[0].collection).toBe('episodic');
      // The durable dup and the spliced-off LTM result must NOT be published.
      expect(payload.memoryIds).not.toContain('d1');
      expect(payload.memoryIds).not.toContain('l2');
    });

    it('does NOT publish when no LTM-origin memory survives into the response', async () => {
      // Durable fully fills the limit; the only LTM hit is a dup of durable and is
      // spliced off. No NEW LTM memory reaches the caller → no strengthen event.
      mocks.recall.mockResolvedValue([
        { memory: { id: 'd1', content: 'durable winner' }, score: 0.99 },
      ]);
      mocks.ltmRecall.mockResolvedValue([
        { memory: { id: 'd1', content: 'durable winner' }, score: 0.5, collection: 'semantic' },
      ]);

      const res = await withProject(request(app).post('/api/memory/recall'), 'testproject').send({
        query: 'recent work',
        limit: 1,
      });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].memory.id).toBe('d1');

      const recalledCalls = mockedPublishEvent.mock.calls.filter((c) => c[0] === 'memory:recalled');
      expect(recalledCalls).toHaveLength(0);
    });
  });

  describe('DELETE /api/memory/:id', () => {
    it('deletes a durable memory', async () => {
      mocks.getById.mockResolvedValue({ id: 'abc-123', content: 'x' });
      mocks.forget.mockResolvedValue(true);

      const res = await withProject(request(app).delete('/api/memory/abc-123'), 'testproject').send(
        {}
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tier).toBe('durable');
      expect(mocks.forget).toHaveBeenCalledWith('testproject', 'abc-123');
      expect(mocks.deleteFromQuarantine).not.toHaveBeenCalled();
    });

    it('falls back to quarantine when the id is an unpromoted memory-tool write (M2)', async () => {
      mocks.getById.mockResolvedValue(null);
      mocks.getQuarantineById.mockResolvedValue({ id: 'q-9', content: 'pending' });
      mocks.deleteFromQuarantine.mockResolvedValue(true);

      const res = await withProject(request(app).delete('/api/memory/q-9'), 'testproject').send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tier).toBe('quarantine');
      expect(mocks.deleteFromQuarantine).toHaveBeenCalledWith('testproject', 'q-9');
      expect(mocks.forget).not.toHaveBeenCalled();
    });

    it('keeps legacy idempotent semantics for unknown ids', async () => {
      mocks.getById.mockResolvedValue(null);
      mocks.getQuarantineById.mockResolvedValue(null);
      mocks.forget.mockResolvedValue(true);

      const res = await withProject(request(app).delete('/api/memory/ghost'), 'testproject').send(
        {}
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mocks.forget).toHaveBeenCalledWith('testproject', 'ghost');
    });
  });

  describe('POST /api/memory/promote', () => {
    it('returns promoted memory', async () => {
      const fakeMemory = { id: 'mem-3', content: 'validated insight', type: 'insight' };
      mocks.promote.mockResolvedValue(fakeMemory);

      const res = await withProject(request(app).post('/api/memory/promote'), 'testproject').send({
        memoryId: 'mem-3',
        reason: 'human_validated',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.memory).toEqual(fakeMemory);
      expect(mocks.promote).toHaveBeenCalledWith(
        'testproject',
        'mem-3',
        'human_validated',
        undefined,
        undefined
      );
    });
  });

  describe('GET /api/memory/quarantine', () => {
    it('returns quarantine memories', async () => {
      const fakeMemories = [{ id: 'q-1', content: 'quarantine item' }];
      mocks.listQuarantine.mockResolvedValue(fakeMemories);

      const res = await withProject(request(app).get('/api/memory/quarantine'), 'testproject');

      expect(res.status).toBe(200);
      expect(res.body.memories).toEqual(fakeMemories);
      expect(res.body.count).toBe(1);
      expect(mocks.listQuarantine).toHaveBeenCalledWith('testproject', 20, undefined, undefined);
    });

    it('forwards ?tag= to listQuarantine (M2 read-your-writes path lookup)', async () => {
      const tag = 'mem:path=/memories/auth.md';
      mocks.listQuarantine.mockResolvedValue([]);

      const res = await withProject(
        request(app).get(`/api/memory/quarantine?tag=${encodeURIComponent(tag)}`),
        'testproject'
      );

      expect(res.status).toBe(200);
      expect(mocks.listQuarantine).toHaveBeenCalledWith('testproject', 20, undefined, tag);
    });
  });

  describe('POST /api/memory/maintenance', () => {
    it('runs maintenance and returns result', async () => {
      const fakeResult = { quarantineDeleted: 3, compactionRuns: 0 };
      mocks.runMaintenance.mockResolvedValue(fakeResult);

      const res = await withProject(
        request(app).post('/api/memory/maintenance'),
        'testproject'
      ).send({
        operations: {
          quarantine_cleanup: true,
          compaction: false,
          compaction_dry_run: true,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(fakeResult);
      expect(mocks.runMaintenance).toHaveBeenCalledOnce();
    });

    it('accepts legacy payloads with feedback_maintenance flag and strips it', async () => {
      // mcp < 0.5.0 still sends feedback_maintenance — the route must not reject it.
      const fakeResult = { quarantineDeleted: 0 };
      mocks.runMaintenance.mockResolvedValue(fakeResult);

      const res = await withProject(
        request(app).post('/api/memory/maintenance'),
        'testproject'
      ).send({
        operations: {
          quarantine_cleanup: true,
          feedback_maintenance: true,
          compaction: false,
        },
      });

      expect(res.status).toBe(200);
      expect(mocks.runMaintenance).toHaveBeenCalledOnce();
      const passedOps = mocks.runMaintenance.mock.calls[0][1];
      expect(passedOps).not.toHaveProperty('feedback_maintenance');
      expect(passedOps.quarantine_cleanup).toBe(true);
    });
  });

  describe('POST /api/memory/forget-older', () => {
    it('happy path returns deletion counts', async () => {
      mocks.forgetOlderThan.mockResolvedValueOnce(5).mockResolvedValueOnce(2);

      const res = await withProject(
        request(app).post('/api/memory/forget-older'),
        'testproject'
      ).send({ olderThanDays: 30 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deleted).toBe(7);
      expect(res.body.durable).toBe(5);
      expect(res.body.quarantine).toBe(2);
      expect(res.body.olderThanDays).toBe(30);
    });

    it('olderThanDays less than 1 returns 400', async () => {
      const res = await withProject(
        request(app).post('/api/memory/forget-older'),
        'testproject'
      ).send({ olderThanDays: 0 });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/memory/merge', () => {
    it('returns merge result with message', async () => {
      const fakeResult = { totalMerged: 3, clusters: [] };
      mocks.mergeMemories.mockResolvedValue(fakeResult);

      const res = await withProject(request(app).post('/api/memory/merge'), 'testproject').send({
        dryRun: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.totalMerged).toBe(3);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.message).toContain('dry run');
    });
  });

  describe('POST /api/memory/extract', () => {
    it('calls conversationAnalyzer.analyze and returns learnings', async () => {
      const fakeAnalysis = {
        learnings: [{ content: 'a learning', type: 'insight', confidence: 0.9 }],
        entities: [],
        summary: 'conversation summary',
      };
      mocks.analyze.mockResolvedValue(fakeAnalysis);

      const res = await withProject(request(app).post('/api/memory/extract'), 'testproject').send({
        conversation: 'User: Hello. Assistant: Hi there.',
      });

      expect(res.status).toBe(200);
      expect(res.body.learnings).toEqual(fakeAnalysis.learnings);
      expect(res.body.summary).toBe('conversation summary');
      expect(mocks.analyze).toHaveBeenCalledOnce();
    });
  });
});
