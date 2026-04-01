import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, withProject } from '../helpers/app-factory';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  getAgentTypes: vi.fn(),
  getProfile: vi.fn(),
  refreshProfile: vi.fn(),
  claudeRun: vi.fn(),
  claudeStop: vi.fn(),
  claudeGetRunning: vi.fn(),
  claudeGetTypes: vi.fn(),
}));

vi.mock('../../services/agent-runtime', () => ({
  agentRuntime: { run: mocks.run, getAgentTypes: mocks.getAgentTypes },
}));
vi.mock('../../services/claude-agent', () => ({
  claudeAgentService: {
    run: mocks.claudeRun,
    stop: mocks.claudeStop,
    getRunningAgents: mocks.claudeGetRunning,
    getAgentTypes: mocks.claudeGetTypes,
  },
}));
vi.mock('../../services/project-profile', () => ({
  projectProfileService: { getProfile: mocks.getProfile, refreshProfile: mocks.refreshProfile },
}));

import agentRoutes from '../../routes/agents';

const app = createTestApp({ router: agentRoutes });

describe('Agent Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.claudeGetTypes.mockReturnValue([]);
    mocks.claudeGetRunning.mockReturnValue([]);
  });

  describe('POST /api/agent/run', () => {
    it('runs an agent', async () => {
      mocks.run.mockResolvedValue({
        id: 'task-1',
        type: 'research',
        status: 'completed',
        result: 'answer',
        steps: [],
        usage: { totalTokens: 100, iterations: 2, toolCalls: 1, durationMs: 500 },
      });

      const res = await withProject(request(app).post('/api/agent/run')).send({
        agentType: 'research',
        task: 'find auth code',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.result).toBe('answer');
    });

    it('returns 400 when projectName is missing', async () => {
      const res = await request(app)
        .post('/api/agent/run')
        .send({ agentType: 'research', task: 'find auth' });
      expect(res.status).toBe(400);
    });

    it('strips thinking from steps when not requested', async () => {
      mocks.run.mockResolvedValue({
        id: 'task-1',
        type: 'research',
        status: 'completed',
        result: 'done',
        usage: { totalTokens: 0, iterations: 1, toolCalls: 0, durationMs: 100 },
        steps: [
          {
            iteration: 1,
            thought: 'hmm',
            thinking: 'secret reasoning',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const res = await withProject(request(app).post('/api/agent/run')).send({
        agentType: 'research',
        task: 'test',
      });

      expect(res.status).toBe(200);
      expect(res.body.steps[0].thinking).toBeUndefined();
      expect(res.body.steps[0].thought).toBe('hmm');
    });
  });

  describe('GET /api/agent/types', () => {
    it('returns both agent types and autonomous types', async () => {
      mocks.getAgentTypes.mockReturnValue([{ name: 'research', description: 'Research agent' }]);
      mocks.claudeGetTypes.mockReturnValue([
        { type: 'research', description: 'Autonomous research', defaultBudget: 1.0 },
      ]);

      const res = await request(app).get('/api/agent/types');
      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.autonomous).toHaveLength(1);
    });
  });

  // ============================================
  // Autonomous Agent Routes
  // ============================================

  describe('POST /api/agent/autonomous', () => {
    it('runs an autonomous agent', async () => {
      mocks.claudeRun.mockResolvedValue({
        id: 'auto-1',
        type: 'research',
        task: 'find auth code',
        projectName: 'test',
        status: 'completed',
        result: 'Auth is in auth.ts',
        cost: 0.05,
        numTurns: 3,
        durationMs: 5000,
      });

      const res = await withProject(request(app).post('/api/agent/autonomous')).send({
        type: 'research',
        task: 'find auth code',
        projectPath: '/home/user/project',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.result).toBe('Auth is in auth.ts');
      expect(res.body.cost).toBe(0.05);
    });

    it('returns 400 when projectPath is missing', async () => {
      const res = await withProject(request(app).post('/api/agent/autonomous')).send({
        type: 'research',
        task: 'test',
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid agent type', async () => {
      const res = await withProject(request(app).post('/api/agent/autonomous')).send({
        type: 'invalid',
        task: 'test',
        projectPath: '/tmp',
      });

      expect(res.status).toBe(400);
    });

    it('passes optional parameters', async () => {
      mocks.claudeRun.mockResolvedValue({
        id: 'auto-2',
        type: 'implement',
        task: 'add feature',
        projectName: 'test',
        status: 'completed',
        result: 'Done',
      });

      await withProject(request(app).post('/api/agent/autonomous')).send({
        type: 'implement',
        task: 'add feature',
        projectPath: '/tmp',
        maxTurns: 10,
        maxBudgetUsd: 2.0,
        model: 'claude-opus-4-6',
        effort: 'max',
      });

      expect(mocks.claudeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTurns: 10,
          maxBudgetUsd: 2.0,
          model: 'claude-opus-4-6',
          effort: 'max',
        })
      );
    });
  });

  describe('POST /api/agent/autonomous/stop', () => {
    it('stops a running agent', async () => {
      mocks.claudeStop.mockReturnValue(true);

      const res = await request(app)
        .post('/api/agent/autonomous/stop')
        .send({ agentId: '550e8400-e29b-41d4-a716-446655440000' });

      expect(res.status).toBe(200);
      expect(res.body.stopped).toBe(true);
    });

    it('returns false for unknown agent', async () => {
      mocks.claudeStop.mockReturnValue(false);

      const res = await request(app)
        .post('/api/agent/autonomous/stop')
        .send({ agentId: '550e8400-e29b-41d4-a716-446655440000' });

      expect(res.status).toBe(200);
      expect(res.body.stopped).toBe(false);
    });

    it('returns 400 for invalid agentId', async () => {
      const res = await request(app)
        .post('/api/agent/autonomous/stop')
        .send({ agentId: 'not-a-uuid' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/agent/autonomous/running', () => {
    it('returns list of running agents', async () => {
      mocks.claudeGetRunning.mockReturnValue(['agent-1', 'agent-2']);

      const res = await request(app).get('/api/agent/autonomous/running');

      expect(res.status).toBe(200);
      expect(res.body.running).toHaveLength(2);
      expect(res.body.count).toBe(2);
    });

    it('returns empty when no agents running', async () => {
      mocks.claudeGetRunning.mockReturnValue([]);

      const res = await request(app).get('/api/agent/autonomous/running');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
    });
  });

  // ============================================
  // Project Profile
  // ============================================

  describe('GET /api/project-profile', () => {
    it('returns profile', async () => {
      mocks.getProfile.mockResolvedValue({ name: 'test', language: 'typescript' });

      const res = await withProject(request(app).get('/api/project-profile'));
      expect(res.status).toBe(200);
      expect(res.body.language).toBe('typescript');
    });
  });

  describe('POST /api/project-profile/refresh', () => {
    it('refreshes profile', async () => {
      mocks.refreshProfile.mockResolvedValue({
        name: 'test',
        language: 'typescript',
        refreshedAt: 'now',
      });

      const res = await withProject(request(app).post('/api/project-profile/refresh'));
      expect(res.status).toBe(200);
    });
  });
});
