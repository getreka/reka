import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  anthropicCreate: vi.fn(),
  anthropicStream: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.post,
  },
}));

// Mock the SDK module so the import in llm.ts resolves to a dummy
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {}
    messages = {
      create: mocks.anthropicCreate,
      stream: mocks.anthropicStream,
    };
  },
}));

/** Helper: build a mock Anthropic client with our mocked methods */
function mockAnthropicClient() {
  return {
    messages: {
      create: mocks.anthropicCreate,
      stream: mocks.anthropicStream,
    },
  };
}

// config is globally mocked in setup.ts (LLM_PROVIDER: 'ollama')
import config from '../../config';
import { llm } from '../../services/llm';

const mockedConfig = vi.mocked(config, true) as Record<string, unknown>;

describe('LLMService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset to defaults from setup.ts
    mockedConfig.LLM_PROVIDER = 'ollama';
    mockedConfig.OLLAMA_THINK = false;
    mockedConfig.OLLAMA_URL = 'http://localhost:11434';
    mockedConfig.OLLAMA_MODEL = 'qwen2.5:32b';
    mockedConfig.OPENAI_MODEL = 'gpt-4-turbo-preview';
    mockedConfig.OPENAI_API_KEY = 'sk-test';
    mockedConfig.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    mockedConfig.ANTHROPIC_API_KEY = 'anthro-test';
    mockedConfig.ANTHROPIC_THINK = false;
  });

  describe('complete() with ollama provider', () => {
    it('sends correct URL, model, and payload to ollama /api/chat', async () => {
      mocks.post.mockResolvedValue({
        data: {
          message: { content: 'hello from ollama' },
          eval_count: 10,
          prompt_eval_count: 5,
        },
      });

      const result = await llm.complete('test prompt');

      expect(mocks.post).toHaveBeenCalledWith(
        'http://localhost:11434/api/chat',
        expect.objectContaining({
          model: 'qwen2.5:32b',
          stream: false,
          messages: [{ role: 'user', content: 'test prompt' }],
        }),
        expect.objectContaining({ timeout: expect.any(Number) })
      );

      expect(result.text).toBe('hello from ollama');
      expect(result.usage).toEqual({
        promptTokens: 5,
        completionTokens: 10,
        totalTokens: 15,
      });
    });

    it('includes systemPrompt as first message when provided', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'response' } },
      });

      await llm.complete('user prompt', { systemPrompt: 'You are helpful' });

      const body = mocks.post.mock.calls[0][1];
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'user prompt' });
    });

    it('returns undefined usage when eval_count is absent', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'no usage' } },
      });

      const result = await llm.complete('prompt');

      expect(result.usage).toBeUndefined();
    });

    it('adds format:json to body when format option is json', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: '{}' } },
      });

      await llm.complete('return json', { format: 'json' });

      const body = mocks.post.mock.calls[0][1];
      expect(body.format).toBe('json');
    });

    it('does not add format field when format is null', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'text' } },
      });

      await llm.complete('prompt', { format: null });

      const body = mocks.post.mock.calls[0][1];
      expect(body.format).toBeUndefined();
    });

    it('injects think:true in body when OLLAMA_THINK is true', async () => {
      mockedConfig.OLLAMA_THINK = true;
      mocks.post.mockResolvedValue({
        data: {
          message: { content: 'thought response', thinking: 'let me think...' },
        },
      });

      const result = await llm.complete('think about this');

      const body = mocks.post.mock.calls[0][1];
      expect(body.think).toBe(true);
      expect(result.thinking).toBe('let me think...');
    });

    it('uses 180s timeout with think mode and 120s without', async () => {
      mockedConfig.OLLAMA_THINK = true;
      mocks.post.mockResolvedValue({ data: { message: { content: 'ok' } } });

      await llm.complete('prompt', { think: true });
      expect(mocks.post.mock.calls[0][2].timeout).toBe(180000);

      mocks.post.mockClear();
      mocks.post.mockResolvedValue({ data: { message: { content: 'ok' } } });

      await llm.complete('prompt', { think: false });
      expect(mocks.post.mock.calls[0][2].timeout).toBe(120000);
    });

    it('retries without think when ollama returns 400 with think mode', async () => {
      mockedConfig.OLLAMA_THINK = true;
      const err = Object.assign(new Error('Bad Request'), { response: { status: 400 } });
      mocks.post
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ data: { message: { content: 'retry ok' } } });

      const result = await llm.complete('tricky prompt');

      expect(mocks.post).toHaveBeenCalledTimes(2);
      const retryBody = mocks.post.mock.calls[1][1];
      expect(retryBody.think).toBeUndefined();
      expect(result.text).toBe('retry ok');
    });

    it('retries without think when ollama returns 500 with think mode', async () => {
      mockedConfig.OLLAMA_THINK = true;
      const err = Object.assign(new Error('Server Error'), { response: { status: 500 } });
      mocks.post
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ data: { message: { content: 'fallback' } } });

      const result = await llm.complete('oom prompt');

      expect(mocks.post).toHaveBeenCalledTimes(2);
      expect(result.text).toBe('fallback');
    });

    it('throws when think mode fails with non-400 error', async () => {
      mockedConfig.OLLAMA_THINK = true;
      const err = Object.assign(new Error('Network error'), { response: { status: 503 } });
      mocks.post.mockRejectedValue(err);

      await expect(llm.complete('prompt')).rejects.toThrow('Network error');
      // Think mode retries without thinking on 400/500, so post may be called twice
      expect(mocks.post).toHaveBeenCalled();
    });
  });

  describe('complete() with openai provider', () => {
    beforeEach(() => {
      (llm as any).provider = 'openai';
    });

    afterEach(() => {
      (llm as any).provider = 'ollama';
    });

    it('sends correct URL, headers, and payload to openai', async () => {
      mocks.post.mockResolvedValue({
        data: {
          choices: [{ message: { content: 'openai response' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
      });

      const result = await llm.complete('openai prompt');

      expect(mocks.post).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          model: 'gpt-4-turbo-preview',
          messages: [{ role: 'user', content: 'openai prompt' }],
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test',
          }),
        })
      );

      expect(result.text).toBe('openai response');
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      });
    });

    it('throws on openai error', async () => {
      mocks.post.mockRejectedValue(new Error('OpenAI failure'));

      await expect(llm.complete('prompt')).rejects.toThrow('OpenAI failure');
    });
  });

  describe('complete() with anthropic provider', () => {
    beforeEach(() => {
      (llm as any).provider = 'anthropic';
      // Ensure client is initialized
      (llm as any).anthropicClient = mockAnthropicClient();
    });

    afterEach(() => {
      (llm as any).provider = 'ollama';
    });

    it('calls SDK messages.create with correct params', async () => {
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'anthropic response' }],
        usage: { input_tokens: 8, output_tokens: 16 },
      });

      const result = await llm.complete('anthropic prompt', {
        systemPrompt: 'Be concise',
        maxTokens: 1024,
        temperature: 0.5,
      });

      expect(mocks.anthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: 'Be concise',
          messages: [{ role: 'user', content: 'anthropic prompt' }],
          temperature: 0.5,
        })
      );

      expect(result.text).toBe('anthropic response');
      expect(result.usage).toEqual({
        promptTokens: 8,
        completionTokens: 16,
        totalTokens: 24,
      });
      expect(result.provider).toBe('anthropic');
    });

    it('enables thinking when ANTHROPIC_THINK is true', async () => {
      mockedConfig.ANTHROPIC_THINK = true;
      mocks.anthropicCreate.mockResolvedValue({
        content: [
          { type: 'thinking', thinking: 'Let me analyze this...' },
          { type: 'text', text: 'The answer is 42' },
        ],
        usage: { input_tokens: 10, output_tokens: 50 },
      });

      const result = await llm.complete('deep question');

      expect(mocks.anthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: expect.any(Number) },
        })
      );

      expect(result.text).toBe('The answer is 42');
      expect(result.thinking).toBe('Let me analyze this...');
    });

    it('does not set temperature when thinking is enabled', async () => {
      mockedConfig.ANTHROPIC_THINK = true;
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      await llm.complete('prompt', { temperature: 0.5 });

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.temperature).toBeUndefined();
    });

    it('appends JSON instruction to system prompt when format is json', async () => {
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"key": "value"}' }],
        usage: { input_tokens: 5, output_tokens: 10 },
      });

      await llm.complete('return json', {
        systemPrompt: 'You are helpful',
        format: 'json',
      });

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.system).toContain('You are helpful');
      expect(params.system).toContain('valid JSON only');
    });

    it('retries without thinking on 400 error', async () => {
      mockedConfig.ANTHROPIC_THINK = true;
      const err = Object.assign(new Error('Bad Request'), { status: 400 });
      mocks.anthropicCreate.mockRejectedValueOnce(err).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'retry ok' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const result = await llm.complete('prompt');

      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(2);
      const retryParams = mocks.anthropicCreate.mock.calls[1][0];
      expect(retryParams.thinking).toBeUndefined();
      expect(result.text).toBe('retry ok');
    });

    it('throws on non-400 error', async () => {
      const err = Object.assign(new Error('Rate limit'), { status: 429 });
      mocks.anthropicCreate.mockRejectedValue(err);

      await expect(llm.complete('prompt')).rejects.toThrow('Rate limit');
    });

    it('throws when no API key configured', async () => {
      (llm as any).anthropicClient = null;

      await expect(llm.complete('prompt')).rejects.toThrow('Anthropic API key not configured');
    });
  });

  describe('completeWithBestProvider()', () => {
    beforeEach(() => {
      // Ensure anthropic client exists for hybrid routing tests
      (llm as any).anthropicClient = mockAnthropicClient();
    });

    it('routes utility tasks to Ollama with think:false', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'utility response' } },
      });

      const result = await llm.completeWithBestProvider('route this', { complexity: 'utility' });

      expect(mocks.post).toHaveBeenCalled();
      const body = mocks.post.mock.calls[0][1];
      expect(body.think).toBeUndefined(); // think: false means no think field
      expect(result.text).toBe('utility response');
    });

    it('routes complex tasks to Claude', async () => {
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'complex analysis' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = await llm.completeWithBestProvider('analyze deeply', {
        complexity: 'complex',
      });

      expect(mocks.anthropicCreate).toHaveBeenCalled();
      expect(result.text).toBe('complex analysis');
    });

    it('falls back to default provider for complex when no Claude key', async () => {
      (llm as any).anthropicClient = null;
      mocks.post.mockResolvedValue({
        data: { message: { content: 'ollama fallback' } },
      });

      const result = await llm.completeWithBestProvider('analyze', { complexity: 'complex' });

      expect(mocks.post).toHaveBeenCalled();
      expect(result.text).toBe('ollama fallback');
    });

    it('routes standard tasks to configured provider', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'standard response' } },
      });

      const result = await llm.completeWithBestProvider('normal task', { complexity: 'standard' });

      expect(mocks.post).toHaveBeenCalled();
      expect(result.text).toBe('standard response');
    });
  });

  describe('chat()', () => {
    it('routes to Ollama by default and returns text', async () => {
      mocks.post.mockResolvedValue({
        data: {
          message: { content: 'chat response' },
          prompt_eval_count: 10,
          eval_count: 20,
        },
      });

      const result = await llm.chat([
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ]);

      expect(mocks.post).toHaveBeenCalled();
      expect(result.text).toBe('chat response');
      expect(result.toolUse).toBeUndefined();
    });

    it('routes to Anthropic when provider specified', async () => {
      (llm as any).anthropicClient = mockAnthropicClient();
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'claude chat' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = await llm.chat([{ role: 'user', content: 'Hello' }], {
        provider: 'anthropic',
      });

      expect(mocks.anthropicCreate).toHaveBeenCalled();
      expect(result.text).toBe('claude chat');
    });

    it('returns tool_use blocks from Claude response', async () => {
      (llm as any).anthropicClient = mockAnthropicClient();
      mocks.anthropicCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'I will search for that.' },
          { type: 'tool_use', id: 'call_1', name: 'search_codebase', input: { query: 'auth' } },
        ],
        usage: { input_tokens: 10, output_tokens: 30 },
      });

      const result = await llm.chat([{ role: 'user', content: 'find auth code' }], {
        provider: 'anthropic',
        tools: [
          {
            name: 'search_codebase',
            description: 'Search codebase',
            input_schema: {
              type: 'object' as const,
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
      });

      expect(result.toolUse).toHaveLength(1);
      expect(result.toolUse![0].name).toBe('search_codebase');
      expect(result.toolUse![0].input).toEqual({ query: 'auth' });
    });
  });

  describe('unknown provider', () => {
    it('throws for unknown provider', async () => {
      (llm as any).provider = 'unknown-llm';

      await expect(llm.complete('prompt')).rejects.toThrow('Unknown LLM provider: unknown-llm');

      (llm as any).provider = 'ollama';
    });
  });
});
