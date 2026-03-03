import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  embed: vi.fn().mockResolvedValue(Array(1024).fill(0)),
  search: vi.fn().mockResolvedValue([]),
  recall: vi.fn().mockResolvedValue([]),
  getAgentProfile: vi.fn(),
  listAgentTypes: vi.fn().mockReturnValue([{ name: 'research', description: 'Research agent' }]),
  saveFacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('../../services/embedding', () => ({ embeddingService: { embed: mocks.embed } }));
vi.mock('../../services/vector-store', () => ({ vectorStore: { search: mocks.search } }));
vi.mock('../../services/memory', () => ({ memoryService: { recall: mocks.recall } }));
vi.mock('../../services/agent-profiles', () => ({
  getAgentProfile: mocks.getAgentProfile,
  listAgentTypes: mocks.listAgentTypes,
}));
vi.mock('../../services/fact-extractor', () => ({
  factExtractor: { saveFacts: mocks.saveFacts },
}));
vi.mock('../../utils/metrics', () => ({
  agentRunsTotal: { inc: vi.fn() },
  agentDuration: { observe: vi.fn() },
  agentIterations: { observe: vi.fn() },
  agentActionsTotal: { inc: vi.fn() },
  agentTokensUsed: { inc: vi.fn() },
}));

import { agentRuntime } from '../../services/agent-runtime';

const AGENT_PROFILE = {
  name: 'research',
  systemPrompt: 'You are a research agent.',
  allowedActions: ['search_codebase', 'recall_memory'],
  temperature: 0.3,
  maxIterations: 5,
  timeout: 30000,
};

describe('AgentRuntime', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.embed.mockResolvedValue(Array(1024).fill(0));
    mocks.search.mockResolvedValue([]);
    mocks.recall.mockResolvedValue([]);
    mocks.getAgentProfile.mockReturnValue(AGENT_PROFILE);
    mocks.listAgentTypes.mockReturnValue([{ name: 'research', description: 'Research agent' }]);
  });

  describe('run', () => {
    it('throws on unknown agent type', async () => {
      mocks.getAgentProfile.mockReturnValue(null);

      await expect(
        agentRuntime.run({ projectName: 'test', agentType: 'nonexistent', task: 'test' })
      ).rejects.toThrow(/Unknown agent type/);
    });

    it('completes with FINAL_ANSWER in single turn', async () => {
      mocks.post.mockResolvedValue({
        data: {
          message: { content: 'THOUGHT: I know the answer.\nFINAL_ANSWER: The auth is in auth.ts' },
          prompt_eval_count: 100,
          eval_count: 50,
        },
      });

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'find auth code',
      });

      expect(result.status).toBe('completed');
      expect(result.result).toContain('auth.ts');
      expect(result.usage.iterations).toBe(1);
    });

    it('executes action then completes', async () => {
      // Turn 1: action
      mocks.post.mockResolvedValueOnce({
        data: {
          message: {
            content: 'THOUGHT: Need to search.\nACTION: search_codebase\nACTION_INPUT: {"query": "auth"}',
          },
          prompt_eval_count: 100,
          eval_count: 50,
        },
      });
      // search_codebase action result
      mocks.search.mockResolvedValue([
        { id: '1', score: 0.9, payload: { file: 'auth.ts', content: 'export class Auth {}' } },
      ]);
      // Turn 2: final answer
      mocks.post.mockResolvedValueOnce({
        data: {
          message: { content: 'THOUGHT: Found it.\nFINAL_ANSWER: Auth is in auth.ts' },
          prompt_eval_count: 200,
          eval_count: 60,
        },
      });

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'find auth',
      });

      expect(result.status).toBe('completed');
      expect(result.usage.toolCalls).toBe(1);
      expect(result.usage.iterations).toBe(2);
    });

    it('reports error for disallowed action', async () => {
      // Turn 1: try disallowed action
      mocks.post.mockResolvedValueOnce({
        data: {
          message: { content: 'THOUGHT: Need to hack.\nACTION: forbidden_action\nACTION_INPUT: {}' },
          prompt_eval_count: 50,
          eval_count: 30,
        },
      });
      // Turn 2: give up
      mocks.post.mockResolvedValueOnce({
        data: {
          message: { content: 'THOUGHT: Action not allowed.\nFINAL_ANSWER: Could not complete.' },
          prompt_eval_count: 100,
          eval_count: 40,
        },
      });

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'test',
      });

      expect(result.status).toBe('completed');
      expect(result.steps[0].observation?.result).toContain('not allowed');
    });

    it('handles Ollama failure', async () => {
      mocks.post.mockRejectedValue(new Error('Ollama timeout'));

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'test',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('LLM call failed');
    });
  });

  describe('getAgentTypes', () => {
    it('returns list from profiles', () => {
      const types = agentRuntime.getAgentTypes();
      expect(types).toHaveLength(1);
      expect(types[0].name).toBe('research');
    });
  });
});
