/**
 * LLM Service - Multi-provider support
 *
 * Providers: Ollama (local), OpenAI, Anthropic (via official SDK).
 * Anthropic provider supports adaptive thinking and streaming.
 */

import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import config from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { ollamaCircuit, anthropicCircuit, openaiCircuit } from '../utils/circuit-breaker';
import { llmUsageLogger } from './llm-usage-logger';

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  think?: boolean; // Ollama: think param, Claude: adaptive thinking
  format?: 'json' | null; // Ollama: native JSON mode, Claude: system prompt instruction
  stream?: boolean; // Enable streaming (default false)
}

export interface CompletionResult {
  text: string;
  thinking?: string; // Reasoning trace from thinking mode
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider?: string; // Which provider handled the request
}

export type ComplexityLevel = 'utility' | 'standard' | 'complex';

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
   * Record LLM usage for cost tracking.
   */
  private recordUsage(
    provider: string,
    model: string,
    usage: { promptTokens: number; completionTokens: number } | undefined,
    durationMs: number,
    caller: string,
    opts: { thinking?: boolean; success?: boolean; error?: string; projectName?: string } = {}
  ): void {
    llmUsageLogger.record({
      provider,
      model,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      durationMs,
      caller,
      projectName: opts.projectName,
      thinking: opts.thinking,
      success: opts.success,
      error: opts.error,
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

    if (enableThink) {
      body.think = true;
    }
    if (options.format === 'json') {
      body.format = 'json';
    }

    try {
      const response = await ollamaCircuit.execute(() =>
        withRetry(
          () => axios.post(`${config.OLLAMA_URL}/api/chat`, body, { timeout }),
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
        'complete',
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
          'complete',
          { thinking: false }
        );
        return result;
      }
      this.recordUsage(
        'ollama',
        config.OLLAMA_MODEL,
        undefined,
        Date.now() - startTime,
        'complete',
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
        'complete',
        { success: false, error: error.message }
      );
      logger.error('OpenAI completion failed', { error: error.message });
      throw error;
    }
  }

  // ============================================
  // Anthropic Provider (Official SDK)
  // ============================================

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
    const maxTokens = options.maxTokens ?? 4096;

    // Build system prompt — append JSON instruction if format: 'json'
    let systemPrompt = options.systemPrompt;
    if (options.format === 'json' && systemPrompt) {
      systemPrompt +=
        '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no explanation outside JSON.';
    } else if (options.format === 'json') {
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
          options.temperature
        );
      }

      // Build request params
      const params: Anthropic.MessageCreateParams = {
        model: config.ANTHROPIC_MODEL,
        max_tokens: enableThinking ? Math.max(maxTokens, 16000) : maxTokens,
        messages: [{ role: 'user', content: prompt }],
      };

      if (systemPrompt) {
        params.system = systemPrompt;
      }

      // Temperature: not allowed with thinking, must be 1 for thinking or omit
      if (!enableThinking && options.temperature !== undefined) {
        params.temperature = options.temperature;
      }

      // Adaptive thinking for complex reasoning
      if (enableThinking) {
        params.thinking = {
          type: 'enabled',
          budget_tokens: Math.min(10000, Math.max(maxTokens, 16000) - 1000),
        };
      }

      const response = await anthropicCircuit.execute(() =>
        withRetry(
          () => client.messages.create(params),
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
        'complete',
        { thinking: enableThinking }
      );
      return result;
    } catch (error: any) {
      // Fallback: if thinking fails, retry without it
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
        if (options.temperature !== undefined) {
          params.temperature = options.temperature;
        }
        const response = await client.messages.create(params);
        const result = this.parseAnthropicResponse(response);
        this.recordUsage(
          'anthropic',
          config.ANTHROPIC_MODEL,
          result.usage,
          Date.now() - startTime,
          'complete',
          { thinking: false }
        );
        return result;
      }

      this.recordUsage(
        'anthropic',
        config.ANTHROPIC_MODEL,
        undefined,
        Date.now() - startTime,
        'complete',
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
    temperature?: number
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

    if (!enableThinking && temperature !== undefined) {
      params.temperature = temperature;
    }

    if (enableThinking) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(10000, Math.max(maxTokens, 16000) - 1000),
      };
    }

    const stream = client.messages.stream(params);
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

    return {
      text,
      thinking: thinking || undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      provider: 'anthropic',
    };
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
    promptTokens: number;
    completionTokens: number;
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
    promptTokens: number;
    completionTokens: number;
  }> {
    const startTime = Date.now();
    const client = this.anthropicClient;
    if (!client) {
      throw new Error('Anthropic API key not configured');
    }

    const enableThinking = options.think ?? config.ANTHROPIC_THINK;
    const maxTokens = options.maxTokens ?? 4096;

    // Separate system message from the rest
    const anthropicMessages: Anthropic.MessageParam[] = [];
    let systemPrompt = options.systemPrompt;

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = typeof msg.content === 'string' ? msg.content : systemPrompt;
      } else {
        anthropicMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content as string,
        });
      }
    }

    const params: Anthropic.MessageCreateParams = {
      model: config.ANTHROPIC_MODEL,
      max_tokens: enableThinking ? Math.max(maxTokens, 16000) : maxTokens,
      messages: anthropicMessages,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    if (!enableThinking && options.temperature !== undefined) {
      params.temperature = options.temperature;
    }

    if (enableThinking) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(10000, Math.max(maxTokens, 16000) - 1000),
      };
    }

    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools;
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
    };
    this.recordUsage('anthropic', config.ANTHROPIC_MODEL, usage, Date.now() - startTime, 'chat', {
      thinking: enableThinking,
    });

    return {
      text,
      thinking: thinking || undefined,
      toolUse: toolUse.length > 0 ? toolUse : undefined,
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
        'chat',
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
          'chat',
          { thinking: false }
        );
        return result;
      }
      this.recordUsage(
        'ollama',
        config.AGENT_OLLAMA_MODEL,
        undefined,
        Date.now() - startTime,
        'chat',
        { success: false, error: error.message }
      );
      logger.error('Ollama chat failed', { error: error.message });
      throw new Error(`LLM call failed: ${error.message}`);
    }
  }
}

export const llm = new LLMService();
export default llm;
