import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  anthropicCreate: vi.fn(),
  anthropicStream: vi.fn(),
}));

const metricsMocks = vi.hoisted(() => ({
  requestsInc: vi.fn(),
  tokensInc: vi.fn(),
  durationObserve: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.post,
  },
}));

vi.mock('../../utils/metrics', () => ({
  llmRequestsTotal: { inc: metricsMocks.requestsInc },
  llmTokensUsed: { inc: metricsMocks.tokensInc },
  llmDuration: { observe: metricsMocks.durationObserve },
}));

const usageMocks = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock('../../services/llm-usage-logger', () => ({
  llmUsageLogger: { record: usageMocks.record },
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
import { circuitBreakers } from '../../utils/circuit-breaker';

const mockedConfig = vi.mocked(config, true) as Record<string, unknown>;

describe('LLMService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Mocked provider failures accumulate in the shared breakers — reset between tests
    // so an opened circuit from one test cannot fail the next.
    circuitBreakers.resetAll();
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
        }),
        // Second arg is the SDK request-options bag carrying the AbortSignal.
        expect.anything()
      );

      // Sampling params are never forwarded to the Anthropic Messages API (they 400 on
      // current models) — temperature is dropped on the Anthropic path.
      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.temperature).toBeUndefined();

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
          thinking: { type: 'adaptive' },
        }),
        // Second arg is the SDK request-options bag carrying the AbortSignal.
        expect.anything()
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

    it('sends output_config.effort from config on the Anthropic path', async () => {
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      await llm.complete('prompt');

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.output_config?.effort).toBe('high');
    });

    it('uses output_config.format json_schema instead of JSON instruction when jsonSchema set', async () => {
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"x":1}' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const schema = { type: 'object', properties: { x: { type: 'number' } } };
      await llm.complete('return json', {
        systemPrompt: 'You are helpful',
        format: 'json',
        jsonSchema: schema,
      });

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.output_config?.format).toEqual({ type: 'json_schema', schema });
      // The prose "valid JSON only" instruction must NOT be appended when a schema is supplied.
      expect(params.system).toBe('You are helpful');
    });

    it('flags truncated when stop_reason is max_tokens', async () => {
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'cut off' }],
        usage: { input_tokens: 5, output_tokens: 5 },
        stop_reason: 'max_tokens',
      });

      const result = await llm.complete('long prompt');
      expect(result.truncated).toBe(true);
    });

    it('records cache token usage from the response', async () => {
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'cached' }],
        usage: {
          input_tokens: 5,
          output_tokens: 5,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      });

      const result = await llm.complete('prompt');
      expect(result.usage?.cacheCreationTokens).toBe(100);
      expect(result.usage?.cacheReadTokens).toBe(200);
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

  describe('AbortSignal threading (consolidation abort fix)', () => {
    it('forwards options.signal into the Ollama axios request config', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'ok' } },
      });
      const controller = new AbortController();

      await llm.complete('prompt', { signal: controller.signal });

      // axios.post(url, body, config) — config is the 3rd arg
      const config = mocks.post.mock.calls[0][2];
      expect(config.signal).toBe(controller.signal);
    });

    it('forwards options.signal into the Anthropic SDK request options', async () => {
      (llm as any).provider = 'anthropic';
      (llm as any).anthropicClient = mockAnthropicClient();
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      });
      const controller = new AbortController();

      await llm.complete('prompt', { signal: controller.signal });

      // messages.create(params, requestOptions) — signal is on the 2nd arg
      const requestOptions = mocks.anthropicCreate.mock.calls[0][1];
      expect(requestOptions?.signal).toBe(controller.signal);

      (llm as any).provider = 'ollama';
    });

    it('passes signal through completeWithBestProvider utility routing', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'ok' } },
      });
      const controller = new AbortController();

      await llm.completeWithBestProvider('prompt', {
        complexity: 'utility',
        signal: controller.signal,
      });

      const config = mocks.post.mock.calls[0][2];
      expect(config.signal).toBe(controller.signal);
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
      // qwen3.5 chat endpoint requires explicit think field — omitting causes
      // empty response. Utility complexity sends think:false explicitly.
      expect(body.think).toBe(false);
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

    it('returns raw response content and applies prompt-cache breakpoints on Anthropic chat', async () => {
      (llm as any).anthropicClient = mockAnthropicClient();
      const content = [
        { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'call_1', name: 'search_codebase', input: { query: 'x' } },
      ];
      mocks.anthropicCreate.mockResolvedValue({
        content,
        usage: { input_tokens: 10, output_tokens: 30 },
      });

      const result = await llm.chat([{ role: 'user', content: 'go' }], {
        provider: 'anthropic',
        systemPrompt: 'You are an agent',
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

      // rawContent is returned verbatim (preserves signed thinking blocks)
      expect(result.rawContent).toBe(content);

      const params = mocks.anthropicCreate.mock.calls[0][0];
      // system sent as a block array with a cache_control breakpoint on the last block
      expect(Array.isArray(params.system)).toBe(true);
      expect(params.system[params.system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
      // last tool definition carries cache_control
      expect(params.tools[params.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
      // sampling params not forwarded
      expect(params.temperature).toBeUndefined();
    });
  });

  describe('per-call effort precedence (option > complexity default > config)', () => {
    beforeEach(() => {
      (llm as any).provider = 'anthropic';
      (llm as any).anthropicClient = mockAnthropicClient();
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      });
    });

    afterEach(() => {
      (llm as any).provider = 'ollama';
    });

    it('per-call effort option overrides config.CLAUDE_EFFORT', async () => {
      await llm.complete('prompt', { effort: 'max' });

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.output_config?.effort).toBe('max');
    });

    it('falls back to config.CLAUDE_EFFORT when no effort option is set', async () => {
      mockedConfig.CLAUDE_EFFORT = 'low';

      await llm.complete('prompt');

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.output_config?.effort).toBe('low');
    });

    it('complexity:complex defaults effort to high over config', async () => {
      mockedConfig.CLAUDE_EFFORT = 'low';

      await llm.completeWithBestProvider('prompt', { complexity: 'complex' });

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.output_config?.effort).toBe('high');
    });

    it('explicit effort option beats the complexity default', async () => {
      await llm.completeWithBestProvider('prompt', { complexity: 'complex', effort: 'xhigh' });

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.output_config?.effort).toBe('xhigh');
    });

    it('threads effort into chat() requests', async () => {
      await llm.chat([{ role: 'user', content: 'go' }], {
        provider: 'anthropic',
        effort: 'xhigh',
      });

      const params = mocks.anthropicCreate.mock.calls[0][0];
      expect(params.output_config?.effort).toBe('xhigh');
    });

    it('preserves the per-call effort on the thinking-fallback retry', async () => {
      mockedConfig.ANTHROPIC_THINK = true;
      const err = Object.assign(new Error('Bad Request'), { status: 400 });
      mocks.anthropicCreate.mockReset();
      mocks.anthropicCreate.mockRejectedValueOnce(err).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'retry ok' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      await llm.complete('prompt', { effort: 'medium' });

      const retryParams = mocks.anthropicCreate.mock.calls[1][0];
      expect(retryParams.output_config?.effort).toBe('medium');
    });
  });

  describe('caller attribution (recordUsage)', () => {
    it('threads options.caller into the usage log on complete()', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 2 },
      });

      await llm.complete('prompt', { caller: 'memory-merge' });

      expect(usageMocks.record).toHaveBeenCalledWith(
        expect.objectContaining({ caller: 'memory-merge' })
      );
    });

    it('defaults to caller=complete when unset', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 2 },
      });

      await llm.complete('prompt');

      expect(usageMocks.record).toHaveBeenCalledWith(
        expect.objectContaining({ caller: 'complete' })
      );
    });

    it('threads caller through completeWithBestProvider routing', async () => {
      mocks.post.mockResolvedValue({
        data: { message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 2 },
      });

      await llm.completeWithBestProvider('prompt', {
        complexity: 'utility',
        caller: 'consolidation',
      });

      expect(usageMocks.record).toHaveBeenCalledWith(
        expect.objectContaining({ caller: 'consolidation' })
      );
    });

    it('threads caller into chat() usage records', async () => {
      (llm as any).anthropicClient = mockAnthropicClient();
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      await llm.chat([{ role: 'user', content: 'go' }], {
        provider: 'anthropic',
        caller: 'agent-loop',
      });

      expect(usageMocks.record).toHaveBeenCalledWith(
        expect.objectContaining({ caller: 'agent-loop' })
      );
    });
  });

  describe('Prometheus metrics wiring (recordUsage)', () => {
    it('increments llm_requests_total and input/output token classes on ollama success', async () => {
      mocks.post.mockResolvedValue({
        data: {
          message: { content: 'ok' },
          prompt_eval_count: 7,
          eval_count: 13,
        },
      });

      await llm.complete('prompt');

      expect(metricsMocks.requestsInc).toHaveBeenCalledWith({
        provider: 'ollama',
        model: 'qwen2.5:32b',
        status: 'success',
      });
      expect(metricsMocks.durationObserve).toHaveBeenCalledWith(
        { provider: 'ollama', model: 'qwen2.5:32b' },
        expect.any(Number)
      );
      expect(metricsMocks.tokensInc).toHaveBeenCalledWith(
        { provider: 'ollama', model: 'qwen2.5:32b', type: 'input' },
        7
      );
      expect(metricsMocks.tokensInc).toHaveBeenCalledWith(
        { provider: 'ollama', model: 'qwen2.5:32b', type: 'output' },
        13
      );
      // No cache token classes for non-Anthropic providers
      const types = metricsMocks.tokensInc.mock.calls.map((c) => c[0].type);
      expect(types).not.toContain('cache_read');
      expect(types).not.toContain('cache_write');
    });

    it('increments cache_read/cache_write token classes from Anthropic cache usage', async () => {
      (llm as any).provider = 'anthropic';
      (llm as any).anthropicClient = mockAnthropicClient();
      mocks.anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'cached' }],
        usage: {
          input_tokens: 5,
          output_tokens: 6,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      });

      await llm.complete('prompt');

      expect(metricsMocks.tokensInc).toHaveBeenCalledWith(
        { provider: 'anthropic', model: 'claude-sonnet-4-6', type: 'cache_write' },
        100
      );
      expect(metricsMocks.tokensInc).toHaveBeenCalledWith(
        { provider: 'anthropic', model: 'claude-sonnet-4-6', type: 'cache_read' },
        200
      );

      (llm as any).provider = 'ollama';
    });

    it('increments llm_requests_total with status=error and no token classes on failure', async () => {
      mocks.post.mockRejectedValue(new Error('boom'));

      await expect(llm.complete('prompt')).rejects.toThrow('boom');

      expect(metricsMocks.requestsInc).toHaveBeenCalledWith({
        provider: 'ollama',
        model: 'qwen2.5:32b',
        status: 'error',
      });
      expect(metricsMocks.tokensInc).not.toHaveBeenCalled();
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
