import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, withProject } from '../helpers/app-factory';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  getAgentTypes: vi.fn(),
  getProfile: vi.fn(),
  refreshProfile: vi.fn(),
}));

vi.mock('../../services/agent-runtime', () => ({
  agentRuntime: { run: mocks.run, getAgentTypes: mocks.getAgentTypes },
}));
vi.mock('../../services/project-profile', () => ({
  projectProfileService: { getProfile: mocks.getProfile, refreshProfile: mocks.refreshProfile },
}));

import agentRoutes from '../../routes/agents';

const app = createTestApp({ router: agentRoutes });

describe('Agent Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /api/agent/run', () => {
    it('runs an agent', async () => {
      mocks.run.mockResolvedValue({
        id: 'task-1', type: 'research', status: 'completed',
        result: 'answer', steps: [], usage: { totalTokens: 100, iterations: 2, toolCalls: 1, durationMs: 500 },
      });

      const res = await withProject(request(app).post('/api/agent/run'))
        .send({ agentType: 'research', task: 'find auth code' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.result).toBe('answer');
    });

    it('returns 400 when projectName is missing', async () => {
      const res = await request(app).post('/api/agent/run')
        .send({ agentType: 'research', task: 'find auth' });
      expect(res.status).toBe(400);
    });

    it('strips thinking from steps when not requested', async () => {
      mocks.run.mockResolvedValue({
        id: 'task-1', type: 'research', status: 'completed',
        result: 'done', usage: { totalTokens: 0, iterations: 1, toolCalls: 0, durationMs: 100 },
        steps: [{ iteration: 1, thought: 'hmm', thinking: 'secret reasoning', timestamp: new Date().toISOString() }],
      });

      const res = await withProject(request(app).post('/api/agent/run'))
        .send({ agentType: 'research', task: 'test' });

      expect(res.status).toBe(200);
      expect(res.body.steps[0].thinking).toBeUndefined();
      expect(res.body.steps[0].thought).toBe('hmm');
    });
  });

  describe('GET /api/agent/types', () => {
    it('returns agent types', async () => {
      mocks.getAgentTypes.mockReturnValue([
        { name: 'research', description: 'Research agent' },
      ]);

      const res = await request(app).get('/api/agent/types');
      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
    });
  });

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
      mocks.refreshProfile.mockResolvedValue({ name: 'test', language: 'typescript', refreshedAt: 'now' });

      const res = await withProject(request(app).post('/api/project-profile/refresh'));
      expect(res.status).toBe(200);
    });
  });
});
