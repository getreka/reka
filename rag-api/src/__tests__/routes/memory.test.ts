import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  recallDurable: vi.fn(),
  runMaintenance: vi.fn(),
  analyze: vi.fn(),
  runGates: vi.fn(),
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
  },
  MemoryType: {},
  TodoStatus: {},
}));

vi.mock('../../services/memory-governance', () => ({
  memoryGovernance: {
    ingest: mocks.ingest,
    promote: mocks.promote,
    listQuarantine: mocks.listQuarantine,
    recallDurable: mocks.recallDurable,
    runMaintenance: mocks.runMaintenance,
  },
  PromoteReason: {},
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

import memoryRoutes from '../../routes/memory';

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

  describe('DELETE /api/memory/:id', () => {
    it('returns success on delete', async () => {
      mocks.forget.mockResolvedValue(true);

      const res = await withProject(request(app).delete('/api/memory/abc-123'), 'testproject').send(
        {}
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mocks.forget).toHaveBeenCalledWith('testproject', 'abc-123');
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
          feedback_maintenance: false,
          compaction: false,
          compaction_dry_run: true,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(fakeResult);
      expect(mocks.runMaintenance).toHaveBeenCalledOnce();
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
