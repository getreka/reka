/**
 * LLM Service - Multi-provider support
 *
 * Providers: Ollama (local), OpenAI, Anthropic (via official SDK).
 * Anthropic provider uses adaptive thinking (`thinking: {type: 'adaptive'}`),
 * output_config.effort, prompt caching, structured outputs, and streaming.
 * Sampling parameters (temperature/top_p/top_k) are NOT forwarded to the
 * Anthropic Messages API — they 400 on current models — so temperature is
 * applied for Ollama/OpenAI only.
 */

import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import config from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { ollamaCircuit, anthropicCircuit, openaiCircuit } from '../utils/circuit-breaker';
import { llmUsageLogger } from './llm-usage-logger';
import { llmRequestsTotal, llmTokensUsed, llmDuration } from '../utils/metrics';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number; // Forwarded to Ollama/OpenAI only — Anthropic rejects sampling params
  systemPrompt?: string;
  think?: boolean; // Ollama: think param, Claude: adaptive thinking
  format?: 'json' | null; // Ollama: native JSON mode, Claude: structured outputs (when no jsonSchema)
  jsonSchema?: Record<string, unknown>; // Claude: output_config.format json_schema (overrides format)
  stream?: boolean; // Enable streaming (default false)
  signal?: AbortSignal; // Cancels the in-flight provider call (axios + Anthropic SDK honor it)
  caller?: string; // Usage attribution (e.g. 'consolidation', 'memory-merge', 'tribunal-judge', 'agent-loop')
  effort?: EffortLevel; // Anthropic output_config.effort — precedence: option > complexity default > config.CLAUDE_EFFORT
}

export interface CompletionResult {
  text: string;
  thinking?: string; // Reasoning trace from thinking mode
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheCreationTokens?: number; // Anthropic prompt-cache write tokens (~1.25x cost)
    cacheReadTokens?: number; // Anthropic prompt-cache read tokens (~0.1x cost)
  };
  provider?: string; // Which provider handled the request
  truncated?: boolean; // True if the response was cut off (stop_reason === 'max_tokens')
}

export type ComplexityLevel = 'utility' | 'standard' | 'complex';

// Default output_config.effort per complexity level. Per-call precedence is
// option.effort > this complexity default > config.CLAUDE_EFFORT (no new env knobs).
const COMPLEXITY_EFFORT_DEFAULTS: Partial<Record<ComplexityLevel, EffortLevel>> = {
  complex: 'high',
};

// Failover chains: ordered list of providers to try
type ProviderName = 'ollama' | 'anthropic' | 'openai';
const FAILOVER_CHAINS: Record<ProviderName, ProviderName[]> = {
  ollama: ['ollama', 'anthropic', 'openai'],
  anthropic: ['anthropic', 'ollama'],
  openai: ['openai', 'anthropic', 'ollama'],
};

class LLMService {
  private provider: string;
  private anthropicClient: Anthropic | null = null;

  constructor() {
    this.provider = config.LLM_PROVIDER;
    this.initAnthropicClient();
  }

  private initAnthropicClient(): void {
    if (config.ANTHROPIC_API_KEY) {
      this.anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<CompletionResult> {
    switch (this.provider) {
      case 'ollama':
        return this.completeWithOllama(prompt, options);
      case 'openai':
        return this.completeWithOpenAI(prompt, options);
      case 'anthropic':
        return this.completeWithAnthropic(prompt, options);
      default:
        throw new Error(`Unknown LLM provider: ${this.provider}`);
    }
  }

  /**
   * Intelligent provider routing based on task complexity.
   * - utility: always Ollama (routing, reranking, memory merge) — cheap & fast
   * - standard: use configured provider (default)
   * - complex: always Claude (agents, deep analysis, code review)
   */
  async completeWithBestProvider(
    prompt: string,
    options: CompletionOptions & { complexity?: ComplexityLevel } = {}
  ): Promise<CompletionResult> {
    const { complexity = 'standard', ...completionOptions } = options;

    switch (complexity) {
      case 'utility':
        // Always Ollama for cheap utility tasks
        return this.completeWithOllama(prompt, { ...completionOptions, think: false });

      case 'complex':
        // Always Claude for complex tasks (with thinking if available)
        if (this.anthropicClient) {
          return this.completeWithAnthropic(prompt, {
            ...completionOptions,
            think: completionOptions.think ?? true,
            effort: completionOptions.effort ?? COMPLEXITY_EFFORT_DEFAULTS[complexity],
          });
        }
        // Fallback to configured provider if no Claude key
        logger.warn(
          'Claude requested for complex task but no API key configured, using default provider'
        );
        return this.complete(prompt, completionOptions);

      case 'standard':
      default:
        return this.complete(prompt, completionOptions);
    }
  }

  /**
   * Complete with failover chain. Tries providers in order until one succeeds.
   * Used by critical paths that must not fail silently.
   */
  async completeWithFailover(
    prompt: string,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const chain = FAILOVER_CHAINS[this.provider as ProviderName] || [this.provider as ProviderName];
    let lastError: Error | null = null;

    for (const provider of chain) {
      // Skip providers we can't use
      if (provider === 'anthropic' && !this.anthropicClient) continue;
      if (provider === 'openai' && !config.OPENAI_API_KEY) continue;

      try {
        const result = await this.completeWithProvider(provider, prompt, options);
        if (provider !== chain[0]) {
          logger.info(`LLM failover: ${chain[0]} → ${provider} succeeded`);
        }
        return result;
      } catch (error: any) {
        lastError = error;
        logger.warn(`LLM failover: ${provider} failed`, { error: error.message });
      }
    }

    throw lastError || new Error('All LLM providers failed');
  }

  private async completeWithProvider(
    provider: string,
    prompt: string,
    options: CompletionOptions
  ): Promise<CompletionResult> {
    switch (provider) {
      case 'ollama':
        return this.completeWithOllama(prompt, options);
      case 'openai':
        return this.completeWithOpenAI(prompt, options);
      case 'anthropic':
        return this.completeWithAnthropic(prompt, options);
      default:
        throw new Error(`Unknown LLM provider: ${provider}`);
    }
  }

  /**
   * Record LLM usage for cost tracking and Prometheus metrics.
   */
  private recordUsage(
    provider: string,
    model: string,
    usage:
      | {
          promptTokens: number;
          completionTokens: number;
          cacheCreationTokens?: number;
          cacheReadTokens?: number;
        }
      | undefined,
    durationMs: number,
    caller: string,
    opts: {
      thinking?: boolean;
      success?: boolean;
      error?: string;
      projectName?: string;
      batch?: boolean;
    } = {}
  ): void {
    // Prometheus: llm_requests_total / llm_duration_seconds / llm_tokens_total with
    // token-class labels (input|output|cache_read|cache_write). Cache classes are only
    // incremented when non-zero so non-Anthropic providers don't emit dead series.
    const status = opts.success === false ? 'error' : 'success';
    llmRequestsTotal.inc({ provider, model, status });
    llmDuration.observe({ provider, model }, durationMs / 1000);
    if (usage) {
      llmTokensUsed.inc({ provider, model, type: 'input' }, usage.promptTokens || 0);
      llmTokensUsed.inc({ provider, model, type: 'output' }, usage.completionTokens || 0);
      if (usage.cacheCreationTokens) {
        llmTokensUsed.inc({ provider, model, type: 'cache_write' }, usage.cacheCreationTokens);
      }
      if (usage.cacheReadTokens) {
        llmTokensUsed.inc({ provider, model, type: 'cache_read' }, usage.cacheReadTokens);
      }
    }

    llmUsageLogger.record({
      provider,
      model,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      cacheCreationTokens: usage?.cacheCreationTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      durationMs,
      caller,
      projectName: opts.projectName,
      thinking: opts.thinking,
      success: opts.success,
      error: opts.error,
      batch: opts.batch,
    });
  }

  // ============================================
  // Ollama Provider
  // ============================================

  private async completeWithOllama(
    prompt: string,
    options: CompletionOptions
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const enableThink = options.think ?? config.OLLAMA_THINK;
    const timeout = enableThink ? 180000 : 120000;

    const messages: Array<{ role: string; content: string }> = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model: config.OLLAMA_MODEL,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 2048,
        num_ctx: 4096,
      },
    };

    // qwen3.5 requires explicit think field on chat endpoint (omitting causes empty response)
    body.think = enableThink;
    if (options.format === 'json') {
      body.format = 'json';
    }

    try {
      const response = await ollamaCircuit.execute(() =>
        withRetry(
          () =>
            axios.post(`${config.OLLAMA_URL}/api/chat`, body, { timeout, signal: options.signal }),
          { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 10000 },
          'llm.ollama'
        )
      );

      const thinking = response.data.message?.thinking;
      if (thinking) {
        logger.debug('Thinking trace', {
          thinkingChars: thinking.length,
          preview: thinking.slice(0, 200),
        });
      }

      const result: CompletionResult = {
        text: response.data.message?.content || '',
        thinking,
        usage: response.data.eval_count
          ? {
              promptTokens: response.data.prompt_eval_count || 0,
              completionTokens: response.data.eval_count || 0,
              totalTokens: (response.data.prompt_eval_count || 0) + (response.data.eval_count || 0),
            }
          : undefined,
        provider: 'ollama',
      };
      this.recordUsage(
        'ollama',
        config.OLLAMA_MODEL,
        result.usage,
        Date.now() - startTime,
        options.caller || 'complete',
        { thinking: enableThink }
      );
      return result;
    } catch (error: any) {
      // Fallback: if 400/500 error with think, retry without it (500 = OOM crash with thinking)
      if (enableThink && [400, 500].includes(error.response?.status)) {
        logger.warn('Ollama think mode failed, retrying without thinking');
        delete body.think;
        const response = await axios.post(`${config.OLLAMA_URL}/api/chat`, body, {
          timeout: 120000,
          signal: options.signal,
        });
        const result: CompletionResult = {
          text: response.data.message?.content || '',
          usage: response.data.eval_count
            ? {
                promptTokens: response.data.prompt_eval_count || 0,
                completionTokens: response.data.eval_count || 0,
                totalTokens:
                  (response.data.prompt_eval_count || 0) + (response.data.eval_count || 0),
              }
            : undefined,
          provider: 'ollama',
        };
        this.recordUsage(
          'ollama',
          config.OLLAMA_MODEL,
          result.usage,
          Date.now() - startTime,
          options.caller || 'complete',
          { thinking: false }
        );
        return result;
      }
      this.recordUsage(
        'ollama',
        config.OLLAMA_MODEL,
        undefined,
        Date.now() - startTime,
        options.caller || 'complete',
        { success: false, error: error.message }
      );
      logger.error('Ollama completion failed', { error: error.message });
      throw error;
    }
  }

  // ============================================
  // OpenAI Provider
  // ============================================

  private async completeWithOpenAI(
    prompt: string,
    options: CompletionOptions
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    try {
      const messages: Array<{ role: string; content: string }> = [];

      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await openaiCircuit.execute(() =>
        withRetry(
          () =>
            axios.post(
              'https://api.openai.com/v1/chat/completions',
              {
                model: config.OPENAI_MODEL,
                messages,
                max_tokens: options.maxTokens ?? 2048,
                temperature: options.temperature ?? 0.7,
              },
              {
                headers: {
                  Authorization: `Bearer ${config.OPENAI_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                timeout: 120000,
                signal: options.signal,
              }
            ),
          { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 15000 },
          'llm.openai'
        )
      );

      const result: CompletionResult = {
        text: response.data.choices[0]?.message?.content || '',
        usage: response.data.usage
          ? {
              promptTokens: response.data.usage.prompt_tokens,
              completionTokens: response.data.usage.completion_tokens,
              totalTokens: response.data.usage.total_tokens,
            }
          : undefined,
        provider: 'openai',
      };
      this.recordUsage(
        'openai',
        config.OPENAI_MODEL,
        result.usage,
        Date.now() - startTime,
        'complete'
      );
      return result;
    } catch (error: any) {
      this.recordUsage(
        'openai',
        config.OPENAI_MODEL,
        undefined,
        Date.now() - startTime,
        options.caller || 'complete',
        { success: false, error: error.message }
      );
      logger.error('OpenAI completion failed', { error: error.message });
      throw error;
    }
  }

  // ============================================
  // Anthropic Provider (Official SDK)
  // ============================================

  /**
   * Apply Anthropic-specific request config in one place:
   *  - adaptive thinking (`thinking: {type: 'adaptive'}`) when enabled; OMITTED when disabled
   *    (never send `{type: 'disabled'}` — it 400s on Fable 5)
   *  - output_config.effort: per-call effort when supplied, else config.CLAUDE_EFFORT
   *  - output_config.format json_schema for structured outputs
   * Sampling params are never set here — they 400 on current models.
   */
  private applyAnthropicOutputConfig(
    params: Anthropic.MessageCreateParams,
    enableThinking: boolean,
    jsonSchema?: Record<string, unknown>,
    effort?: EffortLevel
  ): void {
    if (enableThinking) {
      params.thinking = { type: 'adaptive' };
    }

    const outputConfig: Anthropic.OutputConfig = {
      // 'xhigh' is valid on Fable 5 / Opus 4.7+ but absent from the 0.78 SDK enum — cast.
      effort: (effort ?? config.CLAUDE_EFFORT) as Anthropic.OutputConfig['effort'],
    };
    if (jsonSchema) {
      outputConfig.format = { type: 'json_schema', schema: jsonSchema };
    }
    params.output_config = outputConfig;
  }

  private async completeWithAnthropic(
    prompt: string,
    options: CompletionOptions
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const client = this.anthropicClient;
    if (!client) {
      throw new Error('Anthropic API key not configured');
    }

    const enableThinking = options.think ?? config.ANTHROPIC_THINK;
    // Raise the non-streaming default to 16000 so responses aren't truncated mid-thought.
    const maxTokens = options.maxTokens ?? 16000;

    // Build system prompt — append JSON instruction only when no json_schema is supplied.
    // With output_config.format json_schema the constraint is enforced server-side, so the
    // prose instruction is unnecessary (and would only bloat the prompt).
    let systemPrompt = options.systemPrompt;
    if (!options.jsonSchema && options.format === 'json' && systemPrompt) {
      systemPrompt +=
        '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no explanation outside JSON.';
    } else if (!options.jsonSchema && options.format === 'json') {
      systemPrompt = 'Respond with valid JSON only. No markdown, no explanation outside JSON.';
    }

    try {
      if (options.stream) {
        return await this.completeWithAnthropicStream(
          client,
          prompt,
          systemPrompt,
          enableThinking,
          maxTokens,
          options.jsonSchema,
          options.signal,
          options.effort
        );
      }

      // Build request params. Sampling params (temperature/top_p/top_k) are intentionally
      // NOT forwarded — they 400 on current Anthropic models.
      const params: Anthropic.MessageCreateParams = {
        model: config.ANTHROPIC_MODEL,
        max_tokens: enableThinking ? Math.max(maxTokens, 16000) : maxTokens,
        messages: [{ role: 'user', content: prompt }],
      };

      if (systemPrompt) {
        params.system = systemPrompt;
      }

      this.applyAnthropicOutputConfig(params, enableThinking, options.jsonSchema, options.effort);

      const response = await anthropicCircuit.execute(() =>
        withRetry(
          () => client.messages.create(params, { signal: options.signal }),
          {
            maxAttempts: 2,
            baseDelayMs: 1000,
            maxDelayMs: 15000,
            timeoutMs: enableThinking ? 120000 : 60000,
          },
          'llm.anthropic'
        )
      );

      const result = this.parseAnthropicResponse(response);
      this.recordUsage(
        'anthropic',
        config.ANTHROPIC_MODEL,
        result.usage,
        Date.now() - startTime,
        options.caller || 'complete',
        { thinking: enableThinking }
      );
      return result;
    } catch (error: any) {
      // Fallback: if thinking fails, retry without it (omit thinking param entirely)
      if (enableThinking && error.status === 400) {
        logger.warn('Claude thinking mode failed, retrying without thinking', {
          error: error.message,
        });
        const params: Anthropic.MessageCreateParams = {
          model: config.ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        };
        if (systemPrompt) {
          params.system = systemPrompt;
        }
        this.applyAnthropicOutputConfig(params, false, options.jsonSchema, options.effort);
        const response = await client.messages.create(params, { signal: options.signal });
        const result = this.parseAnthropicResponse(response);
        this.recordUsage(
          'anthropic',
          config.ANTHROPIC_MODEL,
          result.usage,
          Date.now() - startTime,
          options.caller || 'complete',
          { thinking: false }
        );
        return result;
      }

      this.recordUsage(
        'anthropic',
        config.ANTHROPIC_MODEL,
        undefined,
        Date.now() - startTime,
        options.caller || 'complete',
        { success: false, error: error.message, thinking: enableThinking }
      );
      logger.error('Anthropic completion failed', {
        error: error.message,
        status: error.status,
      });
      throw error;
    }
  }

  /**
   * Streaming completion via Anthropic SDK.
   * Collects full response and returns as CompletionResult.
   */
  private async completeWithAnthropicStream(
    client: Anthropic,
    prompt: string,
    systemPrompt: string | undefined,
    enableThinking: boolean,
    maxTokens: number,
    jsonSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    effort?: EffortLevel
  ): Promise<CompletionResult> {
    const params: Anthropic.MessageCreateParams = {
      model: config.ANTHROPIC_MODEL,
      max_tokens: enableThinking ? Math.max(maxTokens, 16000) : maxTokens,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    this.applyAnthropicOutputConfig(params, enableThinking, jsonSchema, effort);

    const stream = client.messages.stream(params, { signal });
    const response = await stream.finalMessage();

    return this.parseAnthropicResponse(response);
  }

  /**
   * Parse Anthropic message response into CompletionResult.
   * Handles both text and thinking content blocks.
   */
  private parseAnthropicResponse(response: Anthropic.Message): CompletionResult {
    let text = '';
    let thinking = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'thinking') {
        thinking += block.thinking;
      }
    }

    const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? undefined;
    const cacheReadTokens = response.usage.cache_read_input_tokens ?? undefined;

    const result: CompletionResult = {
      text,
      thinking: thinking || undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        cacheCreationTokens,
        cacheReadTokens,
      },
      provider: 'anthropic',
    };

    if (response.stop_reason === 'max_tokens') {
      logger.warn('Anthropic response truncated (stop_reason=max_tokens)', {
        model: config.ANTHROPIC_MODEL,
        outputTokens: response.usage.output_tokens,
      });
      result.truncated = true;
    }

    return result;
  }

  // ============================================
  // Multi-turn chat support for agents
  // ============================================

  /**
   * Multi-turn chat completion. Used by agent-runtime.
   * Supports Ollama (direct) and Anthropic (SDK with tool_use).
   */
  async chat(
    messages: Array<{ role: string; content: string | Anthropic.ContentBlockParam[] }>,
    options: CompletionOptions & {
      tools?: Anthropic.Tool[];
      provider?: string;
    } = {}
  ): Promise<{
    text: string;
    thinking?: string;
    toolUse?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    // Raw assistant content blocks from the Anthropic response (text + thinking + tool_use,
    // with signatures preserved). Push verbatim into the next turn so signed thinking blocks
    // are not dropped — the Messages API rejects a tool_use continuation otherwise. Undefined
    // for non-Anthropic providers.
    rawContent?: Anthropic.ContentBlock[];
    promptTokens: number;
    completionTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }> {
    const provider = options.provider || this.provider;

    if (provider === 'anthropic') {
      return this.chatWithAnthropic(messages, options);
    }

    return this.chatWithOllamaInternal(messages, options);
  }

  /**
   * Chat via Anthropic SDK with native tool_use support.
   */
  private async chatWithAnthropic(
    messages: Array<{ role: string; content: string | Anthropic.ContentBlockParam[] }>,
    options: CompletionOptions & { tools?: Anthropic.Tool[] }
  ): Promise<{
    text: string;
    thinking?: string;
    toolUse?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    rawContent?: Anthropic.ContentBlock[];
    promptTokens: number;
    completionTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }> {
    const startTime = Date.now();
    const client = this.anthropicClient;
    if (!client) {
      throw new Error('Anthropic API key not configured');
    }

    const enableThinking = options.think ?? config.ANTHROPIC_THINK;
    const maxTokens = options.maxTokens ?? 16000;

    // Separate system message from the rest
    const anthropicMessages: Anthropic.MessageParam[] = [];
    let systemPrompt = options.systemPrompt;

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = typeof msg.content === 'string' ? msg.content : systemPrompt;
      } else {
        anthropicMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content as Anthropic.ContentBlockParam[] | string,
        });
      }
    }

    const params: Anthropic.MessageCreateParams = {
      model: config.ANTHROPIC_MODEL,
      max_tokens: enableThinking ? Math.max(maxTokens, 16000) : maxTokens,
      messages: anthropicMessages,
    };

    // Prompt caching: send the (byte-stable) system prompt as a block array with a
    // cache_control breakpoint on the last block so the system+tools prefix is cached
    // and reused across every iteration of the agent tool loop.
    if (systemPrompt) {
      params.system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
    }

    this.applyAnthropicOutputConfig(params, enableThinking, options.jsonSchema, options.effort);

    if (options.tools && options.tools.length > 0) {
      // Mark the last tool definition with cache_control so the (stable) tool list is cached
      // together with the system prefix. Clone the last tool to avoid mutating the caller's array.
      const tools = options.tools.slice();
      const last = tools[tools.length - 1];
      tools[tools.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      params.tools = tools;
    }

    const response = await anthropicCircuit.execute(() =>
      withRetry(
        () => client.messages.create(params),
        { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 15000 },
        'llm.anthropic.chat'
      )
    );

    let text = '';
    let thinking = '';
    const toolUse: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'thinking') {
        thinking += block.thinking;
      } else if (block.type === 'tool_use') {
        toolUse.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    const usage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? undefined,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
    };
    this.recordUsage(
      'anthropic',
      config.ANTHROPIC_MODEL,
      usage,
      Date.now() - startTime,
      options.caller || 'chat',
      { thinking: enableThinking }
    );

    return {
      text,
      thinking: thinking || undefined,
      toolUse: toolUse.length > 0 ? toolUse : undefined,
      // Preserve the raw assistant content (incl. signed thinking blocks) for verbatim re-push.
      rawContent: response.content,
      ...usage,
    };
  }

  /**
   * Chat via Ollama (text-based, no native tool_use).
   */
  private async chatWithOllamaInternal(
    messages: Array<{ role: string; content: string | any[] }>,
    options: CompletionOptions
  ): Promise<{
    text: string;
    thinking?: string;
    toolUse?: undefined;
    promptTokens: number;
    completionTokens: number;
  }> {
    const startTime = Date.now();
    const enableThink = options.think ?? config.OLLAMA_THINK;
    const timeout = enableThink ? 90000 : 60000;

    // Convert messages to Ollama format (string content only)
    const ollamaMessages = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const body: Record<string, unknown> = {
      model: config.AGENT_OLLAMA_MODEL,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.3,
        num_predict: options.maxTokens ?? 4096,
        num_ctx: 2048,
      },
    };

    if (enableThink) {
      body.think = true;
    }

    try {
      const response = await ollamaCircuit.execute(() =>
        withRetry(
          () => axios.post(`${config.OLLAMA_URL}/api/chat`, body, { timeout }),
          { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 10000 },
          'llm.ollama.chat'
        )
      );

      const thinking = response.data.message?.thinking;
      if (thinking) {
        logger.debug('Agent thinking trace', {
          thinkingChars: thinking.length,
          preview: thinking.slice(0, 200),
        });
      }

      const result = {
        text: response.data.message?.content || '',
        thinking,
        toolUse: undefined as undefined,
        promptTokens: response.data.prompt_eval_count || 0,
        completionTokens: response.data.eval_count || 0,
      };
      this.recordUsage(
        'ollama',
        config.AGENT_OLLAMA_MODEL,
        { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
        Date.now() - startTime,
        options.caller || 'chat',
        { thinking: enableThink }
      );
      return result;
    } catch (error: any) {
      // Fallback: retry without thinking on 400 error
      if (enableThink && error.response?.status === 400) {
        logger.warn('Agent think mode failed, retrying without thinking');
        delete body.think;
        const response = await axios.post(`${config.OLLAMA_URL}/api/chat`, body, {
          timeout: 60000,
        });
        const result = {
          text: response.data.message?.content || '',
          toolUse: undefined as undefined,
          promptTokens: response.data.prompt_eval_count || 0,
          completionTokens: response.data.eval_count || 0,
        };
        this.recordUsage(
          'ollama',
          config.AGENT_OLLAMA_MODEL,
          { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
          Date.now() - startTime,
          options.caller || 'chat',
          { thinking: false }
        );
        return result;
      }
      this.recordUsage(
        'ollama',
        config.AGENT_OLLAMA_MODEL,
        undefined,
        Date.now() - startTime,
        options.caller || 'chat',
        { success: false, error: error.message }
      );
      logger.error('Ollama chat failed', { error: error.message });
      throw new Error(`LLM call failed: ${error.message}`);
    }
  }
}

export const llm = new LLMService();
export default llm;
