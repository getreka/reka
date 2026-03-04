/**
 * Agent Runtime - ReAct loop execution engine for specialized agents.
 *
 * Supports both text-based ReAct (Ollama) and native tool_use (Claude).
 * Provider selection: uses LLM service's chat() method which routes to
 * the configured provider automatically.
 */

import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { logger } from '../utils/logger';
import { embeddingService } from './embedding';
import { vectorStore } from './vector-store';
import { memoryService } from './memory';
import { llm } from './llm';
import { getAgentProfile, listAgentTypes, type AgentProfile, getToolDefinitions } from './agent-profiles';
import {
  agentRunsTotal,
  agentDuration,
  agentIterations,
  agentActionsTotal,
  agentTokensUsed,
} from '../utils/metrics';
import { factExtractor } from './fact-extractor';

// ============================================
// Interfaces
// ============================================

export interface AgentStep {
  iteration: number;
  thought: string;
  thinking?: string;  // Raw reasoning trace from thinking mode
  action?: { tool: string; input: Record<string, unknown>; reasoning: string };
  observation?: { tool: string; result: string; truncated: boolean };
  timestamp: string;
}

export interface AgentTask {
  id: string;
  type: string;
  task: string;
  projectName: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  steps: AgentStep[];
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  usage: {
    totalTokens: number;
    iterations: number;
    toolCalls: number;
    durationMs: number;
  };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ============================================
// Agent Runtime
// ============================================

class AgentRuntime {
  /**
   * Run an agent with the ReAct loop.
   */
  async run(options: {
    projectName: string;
    agentType: string;
    task: string;
    context?: string;
    maxIterations?: number;
    timeout?: number;
  }): Promise<AgentTask> {
    const { projectName, agentType, task, context } = options;

    const profile = getAgentProfile(agentType);
    if (!profile) {
      throw new Error(`Unknown agent type: ${agentType}. Available: ${listAgentTypes().map(a => a.name).join(', ')}`);
    }

    const maxIterations = options.maxIterations ?? profile.maxIterations ?? config.AGENT_MAX_ITERATIONS;
    const timeout = options.timeout ?? profile.timeout ?? config.AGENT_TIMEOUT;

    const agentTask: AgentTask = {
      id: uuidv4(),
      type: agentType,
      task,
      projectName,
      status: 'running',
      steps: [],
      startedAt: new Date().toISOString(),
      usage: { totalTokens: 0, iterations: 0, toolCalls: 0, durationMs: 0 },
    };

    const startTime = Date.now();
    agentRunsTotal.inc({ project: projectName, agent_type: agentType, status: 'started' });

    try {
      // Choose loop based on provider
      const useToolUse = config.LLM_PROVIDER === 'anthropic';
      const result = useToolUse
        ? await this.toolUseLoop(profile, projectName, task, context, maxIterations, timeout, agentTask)
        : await this.reactLoop(profile, projectName, task, context, maxIterations, timeout, agentTask);

      agentTask.status = 'completed';
      agentTask.result = result;
      agentTask.completedAt = new Date().toISOString();
      agentRunsTotal.inc({ project: projectName, agent_type: agentType, status: 'completed' });

      // Extract and save structured facts from observations
      try {
        await factExtractor.saveFacts(projectName, agentTask);
      } catch (factError: any) {
        logger.debug('Fact extraction failed', { error: factError.message });
      }
    } catch (error: any) {
      if (error.message === 'AGENT_TIMEOUT') {
        agentTask.status = 'timeout';
        agentTask.error = `Agent timed out after ${timeout}ms`;
        agentTask.result = this.extractPartialResult(agentTask);
        agentRunsTotal.inc({ project: projectName, agent_type: agentType, status: 'timeout' });
      } else {
        agentTask.status = 'failed';
        agentTask.error = error.message || String(error);
        agentRunsTotal.inc({ project: projectName, agent_type: agentType, status: 'failed' });
      }
    } finally {
      const durationMs = Date.now() - startTime;
      agentTask.usage.durationMs = durationMs;
      agentTask.completedAt = agentTask.completedAt || new Date().toISOString();

      // Record metrics
      agentDuration.observe({ project: projectName, agent_type: agentType }, durationMs / 1000);
      agentIterations.observe({ project: projectName, agent_type: agentType }, agentTask.usage.iterations);
      agentTokensUsed.inc({ project: projectName, agent_type: agentType, type: 'total' }, agentTask.usage.totalTokens);
    }

    return agentTask;
  }

  /**
   * List available agent types.
   */
  getAgentTypes() {
    return listAgentTypes();
  }

  // ============================================
  // Claude Tool Use Loop
  // ============================================

  private async toolUseLoop(
    profile: AgentProfile,
    projectName: string,
    task: string,
    context: string | undefined,
    maxIterations: number,
    timeout: number,
    agentTask: AgentTask
  ): Promise<string> {
    const deadline = Date.now() + timeout;

    // Get Claude tool definitions for this profile
    const tools = getToolDefinitions(profile.allowedActions);

    // Build message history — Claude uses system prompt separately
    const messages: Array<{ role: string; content: string | any[] }> = [];

    // User message with task and optional context
    let userPrompt = `Task: ${task}`;
    if (context) {
      userPrompt += `\n\nAdditional Context:\n${context}`;
    }
    messages.push({ role: 'user', content: userPrompt });

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const remaining = deadline - Date.now();
      if (remaining <= 5000) {
        throw new Error('AGENT_TIMEOUT');
      }

      agentTask.usage.iterations = iteration;

      // Call Claude via LLM service chat()
      const response = await llm.chat(messages, {
        systemPrompt: profile.systemPrompt,
        tools,
        temperature: profile.temperature,
        maxTokens: 4096,
        think: true,
        provider: 'anthropic',
      });

      agentTask.usage.totalTokens += (response.promptTokens || 0) + (response.completionTokens || 0);

      const step: AgentStep = {
        iteration,
        thought: response.text || '',
        thinking: response.thinking,
        timestamp: new Date().toISOString(),
      };

      // If no tool calls — we have the final answer
      if (!response.toolUse || response.toolUse.length === 0) {
        agentTask.steps.push(step);
        return response.text;
      }

      // Process tool calls
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

      for (const toolCall of response.toolUse) {
        // Validate action is allowed
        if (!profile.allowedActions.includes(toolCall.name)) {
          const errorMsg = `Error: Action "${toolCall.name}" is not allowed. Allowed: ${profile.allowedActions.join(', ')}`;
          toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: errorMsg });
          step.action = { tool: toolCall.name, input: toolCall.input, reasoning: response.text };
          step.observation = { tool: toolCall.name, result: errorMsg, truncated: false };
          continue;
        }

        agentTask.usage.toolCalls++;
        agentActionsTotal.inc({
          project: projectName,
          agent_type: agentTask.type,
          action: toolCall.name,
          success: 'true',
        });

        let observation: string;
        let truncated = false;
        try {
          observation = await this.executeAction(toolCall.name, toolCall.input, projectName);
          if (observation.length > 3000) {
            observation = observation.slice(0, 3000) + '\n... [truncated]';
            truncated = true;
          }
        } catch (error: any) {
          observation = `Error executing ${toolCall.name}: ${error.message}`;
          agentActionsTotal.inc({
            project: projectName,
            agent_type: agentTask.type,
            action: toolCall.name,
            success: 'false',
          });
        }

        toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: observation });
        step.action = { tool: toolCall.name, input: toolCall.input, reasoning: response.text };
        step.observation = { tool: toolCall.name, result: observation, truncated };
      }

      agentTask.steps.push(step);

      // Add assistant response and tool results to history
      // Build assistant content blocks
      const assistantContent: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      > = [];
      if (response.text) {
        assistantContent.push({ type: 'text', text: response.text });
      }
      for (const toolCall of response.toolUse) {
        assistantContent.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });
      messages.push({ role: 'user', content: toolResults });
    }

    // Max iterations reached
    return this.extractPartialResult(agentTask) || 'Agent reached maximum iterations without a final answer.';
  }

  // ============================================
  // ReAct Loop (Ollama text-based)
  // ============================================

  private async reactLoop(
    profile: AgentProfile,
    projectName: string,
    task: string,
    context: string | undefined,
    maxIterations: number,
    timeout: number,
    agentTask: AgentTask
  ): Promise<string> {
    const deadline = Date.now() + timeout;

    // Build message history
    const messages: ChatMessage[] = [
      { role: 'system', content: profile.systemPrompt },
    ];

    // User message with task and optional context
    let userPrompt = `Task: ${task}`;
    if (context) {
      userPrompt += `\n\nAdditional Context:\n${context}`;
    }
    userPrompt += `\n\nAvailable actions: ${profile.allowedActions.join(', ')}`;
    messages.push({ role: 'user', content: userPrompt });

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const remaining = deadline - Date.now();
      if (remaining <= 5000) {
        throw new Error('AGENT_TIMEOUT');
      }

      agentTask.usage.iterations = iteration;

      // Call LLM via chat() method
      const response = await llm.chat(messages, {
        temperature: profile.temperature,
        maxTokens: 4096,
        provider: 'ollama',
      });

      agentTask.usage.totalTokens += (response.promptTokens || 0) + (response.completionTokens || 0);

      const assistantContent = response.text;
      messages.push({ role: 'assistant', content: assistantContent });

      // Parse response
      const parsed = this.parseReactResponse(assistantContent);

      const step: AgentStep = {
        iteration,
        thought: parsed.thought,
        thinking: response.thinking,
        timestamp: new Date().toISOString(),
      };

      // Check for final answer
      if (parsed.finalAnswer) {
        agentTask.steps.push(step);
        return parsed.finalAnswer;
      }

      // Check for action
      if (parsed.action) {
        // Validate action is allowed
        if (!profile.allowedActions.includes(parsed.action.tool)) {
          const observation = `Error: Action "${parsed.action.tool}" is not allowed. Allowed: ${profile.allowedActions.join(', ')}`;
          step.action = { tool: parsed.action.tool, input: parsed.action.input, reasoning: parsed.thought };
          step.observation = { tool: parsed.action.tool, result: observation, truncated: false };
          agentTask.steps.push(step);
          messages.push({ role: 'user', content: `OBSERVATION: ${observation}` });
          continue;
        }

        // Execute action
        agentTask.usage.toolCalls++;
        agentActionsTotal.inc({
          project: projectName,
          agent_type: agentTask.type,
          action: parsed.action.tool,
          success: 'true',
        });

        let observation: string;
        let truncated = false;
        try {
          observation = await this.executeAction(parsed.action.tool, parsed.action.input, projectName);
          // Truncate long observations to keep context manageable
          if (observation.length > 3000) {
            observation = observation.slice(0, 3000) + '\n... [truncated]';
            truncated = true;
          }
        } catch (error: any) {
          observation = `Error executing ${parsed.action.tool}: ${error.message}`;
          agentActionsTotal.inc({
            project: projectName,
            agent_type: agentTask.type,
            action: parsed.action.tool,
            success: 'false',
          });
        }

        step.action = { tool: parsed.action.tool, input: parsed.action.input, reasoning: parsed.thought };
        step.observation = { tool: parsed.action.tool, result: observation, truncated };
        agentTask.steps.push(step);

        // Add observation to history
        messages.push({ role: 'user', content: `OBSERVATION: ${observation}` });
      } else {
        // No action and no final answer — nudge the agent
        agentTask.steps.push(step);
        messages.push({
          role: 'user',
          content: 'No action or final answer detected. Please either use an ACTION or provide a FINAL_ANSWER.',
        });
      }
    }

    // Max iterations reached
    return this.extractPartialResult(agentTask) || 'Agent reached maximum iterations without a final answer.';
  }

  // ============================================
  // Response Parsing
  // ============================================

  private parseReactResponse(text: string): {
    thought: string;
    action?: { tool: string; input: Record<string, unknown> };
    finalAnswer?: string;
  } {
    const result: { thought: string; action?: { tool: string; input: Record<string, unknown> }; finalAnswer?: string } = {
      thought: '',
    };

    // Extract THOUGHT
    const thoughtMatch = text.match(/THOUGHT:\s*([\s\S]*?)(?=\n(?:ACTION|FINAL_ANSWER):|\s*$)/i);
    if (thoughtMatch) {
      result.thought = thoughtMatch[1].trim();
    }

    // Check for FINAL_ANSWER
    const finalMatch = text.match(/FINAL_ANSWER:\s*([\s\S]*)/i);
    if (finalMatch) {
      result.finalAnswer = finalMatch[1].trim();
      return result;
    }

    // Check for ACTION + ACTION_INPUT
    const actionMatch = text.match(/ACTION:\s*(\S+)/i);
    const inputMatch = text.match(/ACTION_INPUT:\s*([\s\S]*?)(?=\n(?:THOUGHT|ACTION|FINAL_ANSWER):|\s*$)/i);

    if (actionMatch) {
      let input: Record<string, unknown> = {};
      if (inputMatch) {
        try {
          input = JSON.parse(inputMatch[1].trim());
        } catch {
          // Try to extract key-value pairs
          input = { query: inputMatch[1].trim() };
        }
      }
      result.action = { tool: actionMatch[1].trim(), input };
    }

    return result;
  }

  // ============================================
  // Action Executors (direct service calls)
  // ============================================

  private async executeAction(
    tool: string,
    input: Record<string, unknown>,
    projectName: string
  ): Promise<string> {
    const executor = this.actionExecutors[tool];
    if (!executor) {
      throw new Error(`Unknown action: ${tool}`);
    }
    return executor(input, projectName);
  }

  private actionExecutors: Record<
    string,
    (input: Record<string, unknown>, projectName: string) => Promise<string>
  > = {
    search_codebase: async (input, projectName) => {
      const query = String(input.query || '');
      const limit = Number(input.limit) || 5;
      const embedding = await embeddingService.embed(query);
      const results = await vectorStore.search(`${projectName}_codebase`, embedding, limit);
      if (results.length === 0) return 'No results found.';
      return results
        .map((r, i) => {
          const file = r.payload.file || 'unknown';
          const content = String(r.payload.content || '').slice(0, 500);
          return `[${i + 1}] ${file} (score: ${r.score.toFixed(3)})\n${content}`;
        })
        .join('\n\n');
    },

    recall_memory: async (input, projectName) => {
      const query = String(input.query || '');
      const limit = Number(input.limit) || 5;
      const type = String(input.type || 'all');
      const results = await memoryService.recall({
        projectName,
        query,
        limit,
        type: type as 'all' | 'decision' | 'insight' | 'context' | 'todo' | 'conversation' | 'note',
      });
      if (results.length === 0) return 'No memories found.';
      return results
        .map((r, i) => `[${i + 1}] [${r.memory.type}] ${r.memory.content} (score: ${r.score.toFixed(3)})`)
        .join('\n');
    },

    get_patterns: async (input, projectName) => {
      const query = String(input.query || 'patterns');
      const results = await memoryService.recall({
        projectName,
        query: `pattern ${query}`,
        type: 'context',
        limit: 5,
      });
      if (results.length === 0) return 'No patterns found.';
      return results
        .map((r, i) => `[${i + 1}] ${r.memory.content} (score: ${r.score.toFixed(3)})`)
        .join('\n');
    },

    get_adrs: async (input, projectName) => {
      const query = String(input.query || 'decisions');
      const results = await memoryService.recall({
        projectName,
        query: `decision ${query}`,
        type: 'decision',
        limit: 5,
      });
      if (results.length === 0) return 'No ADRs found.';
      return results
        .map((r, i) => `[${i + 1}] ${r.memory.content} (score: ${r.score.toFixed(3)})`)
        .join('\n');
    },

    search_similar: async (input, projectName) => {
      const code = String(input.code || input.query || '');
      const limit = Number(input.limit) || 5;
      const embedding = await embeddingService.embed(code);
      const results = await vectorStore.search(`${projectName}_codebase`, embedding, limit);
      if (results.length === 0) return 'No similar code found.';
      return results
        .map((r, i) => {
          const file = r.payload.file || 'unknown';
          const content = String(r.payload.content || '').slice(0, 500);
          return `[${i + 1}] ${file} (score: ${r.score.toFixed(3)})\n${content}`;
        })
        .join('\n\n');
    },
  };

  // ============================================
  // Helpers
  // ============================================

  private extractPartialResult(agentTask: AgentTask): string {
    // Find the last meaningful thought or observation
    for (let i = agentTask.steps.length - 1; i >= 0; i--) {
      const step = agentTask.steps[i];
      if (step.thought && step.thought.length > 50) {
        return `[Partial result after ${agentTask.usage.iterations} iterations]\n\n${step.thought}`;
      }
    }
    return '';
  }
}

export const agentRuntime = new AgentRuntime();
export default agentRuntime;
