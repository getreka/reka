import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.post,
  },
}));

// config is globally mocked in setup.ts (LLM_PROVIDER: 'ollama')
// We import config to override per-test via vi.mocked
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
    mockedConfig.ANTHROPIC_MODEL = 'claude-3-sonnet-20240229';
    mockedConfig.ANTHROPIC_API_KEY = 'anthro-test';
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

      // Re-create to pick up provider at test time via the service's constructor
      // The singleton reads config.LLM_PROVIDER at construction time — we test by calling
      // the already-constructed singleton which dispatches based on this.provider
      // Since setup.ts mocks config with LLM_PROVIDER: 'ollama', the singleton is already ollama.
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
      expect(mocks.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('complete() with openai provider', () => {
    beforeEach(() => {
      // Swap the internal provider by mutating the singleton's private field
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
    });

    afterEach(() => {
      (llm as any).provider = 'ollama';
    });

    it('sends correct URL, headers, and payload to anthropic', async () => {
      mocks.post.mockResolvedValue({
        data: {
          content: [{ text: 'anthropic response' }],
          usage: { input_tokens: 8, output_tokens: 16 },
        },
      });

      const result = await llm.complete('anthropic prompt', { systemPrompt: 'Be concise' });

      expect(mocks.post).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          model: 'claude-3-sonnet-20240229',
          system: 'Be concise',
          messages: [{ role: 'user', content: 'anthropic prompt' }],
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'anthro-test',
            'anthropic-version': '2023-06-01',
          }),
        })
      );

      expect(result.text).toBe('anthropic response');
      expect(result.usage).toEqual({
        promptTokens: 8,
        completionTokens: 16,
        totalTokens: 24,
      });
    });

    it('throws on anthropic error', async () => {
      mocks.post.mockRejectedValue(new Error('Anthropic failure'));

      await expect(llm.complete('prompt')).rejects.toThrow('Anthropic failure');
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
