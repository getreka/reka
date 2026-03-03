/**
 * LLM Service - Multi-provider support
 */

import axios from 'axios';
import config from '../config';
import { logger } from '../utils/logger';

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  think?: boolean;          // Override global thinking (default: config.OLLAMA_THINK)
  format?: 'json' | null;  // Ollama native JSON mode
}

export interface CompletionResult {
  text: string;
  thinking?: string;        // Reasoning trace from thinking mode
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

class LLMService {
  private provider: string;

  constructor() {
    this.provider = config.LLM_PROVIDER;
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

  private async completeWithOllama(prompt: string, options: CompletionOptions): Promise<CompletionResult> {
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
      const response = await axios.post(
        `${config.OLLAMA_URL}/api/chat`,
        body,
        { timeout }
      );

      const thinking = response.data.message?.thinking;
      if (thinking) {
        logger.debug('Thinking trace', {
          thinkingChars: thinking.length,
          preview: thinking.slice(0, 200),
        });
      }

      return {
        text: response.data.message?.content || '',
        thinking,
        usage: response.data.eval_count
          ? {
              promptTokens: response.data.prompt_eval_count || 0,
              completionTokens: response.data.eval_count || 0,
              totalTokens: (response.data.prompt_eval_count || 0) + (response.data.eval_count || 0),
            }
          : undefined,
      };
    } catch (error: any) {
      // Fallback: if 400/500 error with think, retry without it (500 = OOM crash with thinking)
      if (enableThink && [400, 500].includes(error.response?.status)) {
        logger.warn('Ollama think mode failed, retrying without thinking');
        delete body.think;
        const response = await axios.post(
          `${config.OLLAMA_URL}/api/chat`,
          body,
          { timeout: 120000 }
        );
        return {
          text: response.data.message?.content || '',
          usage: response.data.eval_count
            ? {
                promptTokens: response.data.prompt_eval_count || 0,
                completionTokens: response.data.eval_count || 0,
                totalTokens: (response.data.prompt_eval_count || 0) + (response.data.eval_count || 0),
              }
            : undefined,
        };
      }
      logger.error('Ollama completion failed', { error: error.message });
      throw error;
    }
  }

  private async completeWithOpenAI(prompt: string, options: CompletionOptions): Promise<CompletionResult> {
    try {
      const messages = [];

      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await axios.post(
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
      );

      return {
        text: response.data.choices[0]?.message?.content || '',
        usage: response.data.usage
          ? {
              promptTokens: response.data.usage.prompt_tokens,
              completionTokens: response.data.usage.completion_tokens,
              totalTokens: response.data.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error: any) {
      logger.error('OpenAI completion failed', { error: error.message });
      throw error;
    }
  }

  private async completeWithAnthropic(prompt: string, options: CompletionOptions): Promise<CompletionResult> {
    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: config.ANTHROPIC_MODEL,
          max_tokens: options.maxTokens ?? 2048,
          system: options.systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'x-api-key': config.ANTHROPIC_API_KEY,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          timeout: 120000,
        }
      );

      return {
        text: response.data.content[0]?.text || '',
        usage: response.data.usage
          ? {
              promptTokens: response.data.usage.input_tokens,
              completionTokens: response.data.usage.output_tokens,
              totalTokens: response.data.usage.input_tokens + response.data.usage.output_tokens,
            }
          : undefined,
      };
    } catch (error: any) {
      logger.error('Anthropic completion failed', { error: error.message });
      throw error;
    }
  }
}

export const llm = new LLMService();
export default llm;
