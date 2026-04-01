import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  embed: vi.fn().mockResolvedValue(Array(1024).fill(0)),
  search: vi.fn().mockResolvedValue([]),
  recall: vi.fn().mockResolvedValue([]),
  getAgentProfile: vi.fn(),
  listAgentTypes: vi.fn().mockReturnValue([{ name: 'research', description: 'Research agent' }]),
  getToolDefinitions: vi.fn().mockReturnValue([]),
  saveFacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/llm', () => ({
  llm: { chat: mocks.chat, complete: vi.fn(), completeWithBestProvider: vi.fn() },
}));
vi.mock('../../services/embedding', () => ({ embeddingService: { embed: mocks.embed } }));
vi.mock('../../services/vector-store', () => ({ vectorStore: { search: mocks.search } }));
vi.mock('../../services/memory', () => ({ memoryService: { recall: mocks.recall } }));
vi.mock('../../services/agent-profiles', () => ({
  getAgentProfile: mocks.getAgentProfile,
  listAgentTypes: mocks.listAgentTypes,
  getToolDefinitions: mocks.getToolDefinitions,
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

import config from '../../config';
import { agentRuntime } from '../../services/agent-runtime';

const mockedConfig = vi.mocked(config, true) as Record<string, unknown>;

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
    mockedConfig.LLM_PROVIDER = 'ollama';
    mocks.embed.mockResolvedValue(Array(1024).fill(0));
    mocks.search.mockResolvedValue([]);
    mocks.recall.mockResolvedValue([]);
    mocks.getAgentProfile.mockReturnValue(AGENT_PROFILE);
    mocks.listAgentTypes.mockReturnValue([{ name: 'research', description: 'Research agent' }]);
    mocks.getToolDefinitions.mockReturnValue([]);
  });

  describe('run', () => {
    it('throws on unknown agent type', async () => {
      mocks.getAgentProfile.mockReturnValue(null);

      await expect(
        agentRuntime.run({ projectName: 'test', agentType: 'nonexistent', task: 'test' })
      ).rejects.toThrow(/Unknown agent type/);
    });

    it('completes with FINAL_ANSWER in single turn (ReAct)', async () => {
      mocks.chat.mockResolvedValue({
        text: 'THOUGHT: I know the answer.\nFINAL_ANSWER: The auth is in auth.ts',
        promptTokens: 100,
        completionTokens: 50,
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

    it('executes action then completes (ReAct)', async () => {
      // Turn 1: action
      mocks.chat.mockResolvedValueOnce({
        text: 'THOUGHT: Need to search.\nACTION: search_codebase\nACTION_INPUT: {"query": "auth"}',
        promptTokens: 100,
        completionTokens: 50,
      });
      // search_codebase action result
      mocks.search.mockResolvedValue([
        { id: '1', score: 0.9, payload: { file: 'auth.ts', content: 'export class Auth {}' } },
      ]);
      // Turn 2: final answer
      mocks.chat.mockResolvedValueOnce({
        text: 'THOUGHT: Found it.\nFINAL_ANSWER: Auth is in auth.ts',
        promptTokens: 200,
        completionTokens: 60,
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

    it('reports error for disallowed action (ReAct)', async () => {
      // Turn 1: try disallowed action
      mocks.chat.mockResolvedValueOnce({
        text: 'THOUGHT: Need to hack.\nACTION: forbidden_action\nACTION_INPUT: {}',
        promptTokens: 50,
        completionTokens: 30,
      });
      // Turn 2: give up
      mocks.chat.mockResolvedValueOnce({
        text: 'THOUGHT: Action not allowed.\nFINAL_ANSWER: Could not complete.',
        promptTokens: 100,
        completionTokens: 40,
      });

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'test',
      });

      expect(result.status).toBe('completed');
      expect(result.steps[0].observation?.result).toContain('not allowed');
    });

    it('handles LLM failure', async () => {
      mocks.chat.mockRejectedValue(new Error('LLM call failed: timeout'));

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'test',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('LLM call failed');
    });
  });

  describe('Claude tool_use mode', () => {
    beforeEach(() => {
      mockedConfig.LLM_PROVIDER = 'anthropic';
      mocks.getToolDefinitions.mockReturnValue([
        {
          name: 'search_codebase',
          description: 'Search codebase',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ]);
    });

    it('completes with direct text response (no tool calls)', async () => {
      mocks.chat.mockResolvedValue({
        text: 'The auth module is in auth.ts and handles JWT validation.',
        toolUse: undefined,
        promptTokens: 100,
        completionTokens: 50,
      });

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'find auth code',
      });

      expect(result.status).toBe('completed');
      expect(result.result).toContain('auth.ts');
      expect(result.usage.iterations).toBe(1);
      expect(result.usage.toolCalls).toBe(0);
    });

    it('executes tool_use then completes', async () => {
      // Turn 1: tool call
      mocks.chat.mockResolvedValueOnce({
        text: 'Let me search for authentication code.',
        toolUse: [{ id: 'call_1', name: 'search_codebase', input: { query: 'auth' } }],
        promptTokens: 100,
        completionTokens: 50,
      });
      // search result
      mocks.search.mockResolvedValue([
        { id: '1', score: 0.9, payload: { file: 'auth.ts', content: 'export class Auth {}' } },
      ]);
      // Turn 2: final text response
      mocks.chat.mockResolvedValueOnce({
        text: 'Found it. Auth is in auth.ts and exports an Auth class.',
        toolUse: undefined,
        promptTokens: 200,
        completionTokens: 60,
      });

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'find auth',
      });

      expect(result.status).toBe('completed');
      expect(result.usage.toolCalls).toBe(1);
      expect(result.usage.iterations).toBe(2);
      expect(result.steps[0].action?.tool).toBe('search_codebase');
    });

    it('rejects disallowed tool calls', async () => {
      // Turn 1: disallowed tool
      mocks.chat.mockResolvedValueOnce({
        text: 'Let me try a forbidden tool.',
        toolUse: [{ id: 'call_1', name: 'forbidden_action', input: {} }],
        promptTokens: 50,
        completionTokens: 30,
      });
      // Turn 2: final answer
      mocks.chat.mockResolvedValueOnce({
        text: 'The action was not allowed. Cannot complete.',
        toolUse: undefined,
        promptTokens: 100,
        completionTokens: 40,
      });

      const result = await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'test',
      });

      expect(result.status).toBe('completed');
      expect(result.steps[0].observation?.result).toContain('not allowed');
    });

    it('passes tools to llm.chat()', async () => {
      mocks.chat.mockResolvedValue({
        text: 'Direct answer.',
        toolUse: undefined,
        promptTokens: 50,
        completionTokens: 30,
      });

      await agentRuntime.run({
        projectName: 'test',
        agentType: 'research',
        task: 'test',
      });

      expect(mocks.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          tools: expect.any(Array),
          provider: 'anthropic',
          think: true,
        })
      );
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
