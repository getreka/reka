import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query,
}));

import { claudeAgentService } from '../../services/claude-agent';

/** Helper: create an async generator from an array of messages */
async function* mockMessages(messages: any[]): AsyncGenerator<any, void> {
  for (const msg of messages) {
    yield msg;
  }
}

describe('ClaudeAgentService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('run()', () => {
    it('returns completed result on success', async () => {
      mocks.query.mockReturnValue(
        mockMessages([
          {
            type: 'result',
            subtype: 'success',
            result: 'Found auth in auth.ts',
            total_cost_usd: 0.05,
            usage: { input_tokens: 500, output_tokens: 200 },
            num_turns: 3,
            duration_ms: 5000,
            session_id: 'sess-1',
          },
        ])
      );

      const result = await claudeAgentService.run({
        projectName: 'test',
        projectPath: '/tmp/test',
        type: 'research',
        task: 'find auth code',
      });

      expect(result.status).toBe('completed');
      expect(result.result).toBe('Found auth in auth.ts');
      expect(result.cost).toBe(0.05);
      expect(result.usage?.inputTokens).toBe(500);
      expect(result.usage?.outputTokens).toBe(200);
      expect(result.numTurns).toBe(3);
    });

    it('returns failed result on error', async () => {
      mocks.query.mockReturnValue(
        mockMessages([
          {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['API rate limit exceeded'],
            duration_ms: 1000,
            session_id: 'sess-2',
          },
        ])
      );

      const result = await claudeAgentService.run({
        projectName: 'test',
        projectPath: '/tmp/test',
        type: 'review',
        task: 'review auth code',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toBe('API rate limit exceeded');
    });

    it('returns budget_exceeded when budget limit hit', async () => {
      mocks.query.mockReturnValue(
        mockMessages([
          {
            type: 'result',
            subtype: 'error_max_budget_usd',
            errors: ['Budget exceeded'],
            duration_ms: 30000,
            session_id: 'sess-3',
          },
        ])
      );

      const result = await claudeAgentService.run({
        projectName: 'test',
        projectPath: '/tmp/test',
        type: 'implement',
        task: 'implement feature',
        maxBudgetUsd: 0.5,
      });

      expect(result.status).toBe('budget_exceeded');
    });

    it('handles thrown errors', async () => {
      mocks.query.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('Connection failed')),
        }),
      });

      const result = await claudeAgentService.run({
        projectName: 'test',
        projectPath: '/tmp/test',
        type: 'research',
        task: 'test',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Connection failed');
    });

    it('handles abort errors as interrupted', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mocks.query.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(abortError),
        }),
      });

      const result = await claudeAgentService.run({
        projectName: 'test',
        projectPath: '/tmp/test',
        type: 'research',
        task: 'test',
      });

      expect(result.status).toBe('interrupted');
    });

    it('passes query options with correct config', async () => {
      mocks.query.mockReturnValue(
        mockMessages([
          {
            type: 'result',
            subtype: 'success',
            result: 'done',
            total_cost_usd: 0.01,
            usage: { input_tokens: 10, output_tokens: 5 },
            num_turns: 1,
            duration_ms: 100,
            session_id: 'sess-4',
          },
        ])
      );

      await claudeAgentService.run({
        projectName: 'myproject',
        projectPath: '/home/user/myproject',
        type: 'implement',
        task: 'add feature',
        maxTurns: 10,
        maxBudgetUsd: 2.0,
        model: 'claude-opus-4-6',
        effort: 'max',
      });

      expect(mocks.query).toHaveBeenCalledWith({
        prompt: expect.stringContaining('add feature'),
        options: expect.objectContaining({
          cwd: '/home/user/myproject',
          maxTurns: 10,
          maxBudgetUsd: 2.0,
          model: 'claude-opus-4-6',
          effort: 'max',
          permissionMode: 'acceptEdits', // implement type
        }),
      });
    });

    it('collects messages when includeStreaming is true', async () => {
      const assistantMsg = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working...' }] },
      };
      const resultMsg = {
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
        num_turns: 1,
        duration_ms: 100,
        session_id: 'sess-5',
      };

      mocks.query.mockReturnValue(mockMessages([assistantMsg, resultMsg]));

      const result = await claudeAgentService.run({
        projectName: 'test',
        projectPath: '/tmp/test',
        type: 'research',
        task: 'test',
        includeStreaming: true,
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages![0].type).toBe('assistant');
    });

    it('does not include messages when includeStreaming is false', async () => {
      mocks.query.mockReturnValue(
        mockMessages([
          {
            type: 'result',
            subtype: 'success',
            result: 'done',
            total_cost_usd: 0.01,
            usage: { input_tokens: 10, output_tokens: 5 },
            num_turns: 1,
            duration_ms: 100,
            session_id: 'sess-6',
          },
        ])
      );

      const result = await claudeAgentService.run({
        projectName: 'test',
        projectPath: '/tmp/test',
        type: 'research',
        task: 'test',
      });

      expect(result.messages).toBeUndefined();
    });
  });

  describe('stop()', () => {
    it('returns false for unknown agent', () => {
      expect(claudeAgentService.stop('nonexistent')).toBe(false);
    });
  });

  describe('getRunningAgents()', () => {
    it('returns empty array when no agents running', () => {
      expect(claudeAgentService.getRunningAgents()).toEqual([]);
    });
  });

  describe('getAgentTypes()', () => {
    it('returns all 5 autonomous agent types', () => {
      const types = claudeAgentService.getAgentTypes();
      expect(types).toHaveLength(5);

      const typeNames = types.map((t) => t.type);
      expect(typeNames).toContain('research');
      expect(typeNames).toContain('review');
      expect(typeNames).toContain('implement');
      expect(typeNames).toContain('test');
      expect(typeNames).toContain('refactor');

      for (const t of types) {
        expect(t.defaultBudget).toBeGreaterThan(0);
        expect(t.description.length).toBeGreaterThan(10);
      }
    });
  });
});
