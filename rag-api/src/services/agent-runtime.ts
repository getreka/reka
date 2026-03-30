/**
 * Agent Runtime - ReAct loop execution engine for specialized agents.
 *
 * Supports both text-based ReAct (Ollama) and native tool_use (Claude).
 * Provider selection: uses LLM service's chat() method which routes to
 * the configured provider automatically.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { logger } from '../utils/logger';
import { embeddingService } from './embedding';
import { vectorStore } from './vector-store';
import { memoryService } from './memory';
import { llm } from './llm';
import { graphStore } from './graph-store';
import { symbolIndex } from './symbol-index';
import { workRegistry } from './work-handler';
import {
  getAgentProfile,
  listAgentTypes,
  type AgentProfile,
  getToolDefinitions,
} from './agent-profiles';
import {
  agentRunsTotal,
  agentDuration,
  agentIterations,
  agentActionsTotal,
  agentTokensUsed,
} from '../utils/metrics';
import { factExtractor } from './fact-extractor';
import { withSpan } from '../utils/tracing';

// ============================================
// Interfaces
// ============================================

export interface AgentStep {
  iteration: number;
  thought: string;
  thinking?: string; // Raw reasoning trace from thinking mode
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
    projectPath?: string;
  }): Promise<AgentTask> {
    return withSpan(
      'agent_runtime.run',
      {
        agent_type: options.agentType,
        project: options.projectName,
        task: options.task.slice(0, 100),
      },
      async (span) => this._run(options, span)
    );
  }

  private async _run(
    options: {
      projectName: string;
      agentType: string;
      task: string;
      context?: string;
      maxIterations?: number;
      timeout?: number;
      projectPath?: string;
    },
    span?: any
  ): Promise<AgentTask> {
    const { projectName, agentType, task, context, projectPath } = options;

    const profile = getAgentProfile(agentType);
    if (!profile) {
      throw new Error(
        `Unknown agent type: ${agentType}. Available: ${listAgentTypes()
          .map((a) => a.name)
          .join(', ')}`
      );
    }

    const maxIterations =
      options.maxIterations ?? profile.maxIterations ?? config.AGENT_MAX_ITERATIONS;
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

    // Register in work registry
    const workHandle = workRegistry.register({
      id: agentTask.id,
      type: 'agent',
      projectName,
      description: `Agent ${agentType}: ${task.slice(0, 100)}`,
      metadata: { agentType },
    });

    try {
      // Choose loop based on provider
      const useToolUse = config.LLM_PROVIDER === 'anthropic';
      const result = useToolUse
        ? await this.toolUseLoop(
            profile,
            projectName,
            task,
            context,
            maxIterations,
            timeout,
            agentTask,
            projectPath
          )
        : await this.reactLoop(
            profile,
            projectName,
            task,
            context,
            maxIterations,
            timeout,
            agentTask,
            projectPath
          );

      agentTask.status = 'completed';
      agentTask.result = result;
      agentTask.completedAt = new Date().toISOString();
      agentRunsTotal.inc({ project: projectName, agent_type: agentType, status: 'completed' });
      workHandle.complete({
        iterations: agentTask.usage.iterations,
        toolCalls: agentTask.usage.toolCalls,
      });

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
        workHandle.update({ state: 'timeout' });
      } else {
        agentTask.status = 'failed';
        agentTask.error = error.message || String(error);
        agentRunsTotal.inc({ project: projectName, agent_type: agentType, status: 'failed' });
        workHandle.fail(agentTask.error || 'Unknown error');
      }
    } finally {
      const durationMs = Date.now() - startTime;
      agentTask.usage.durationMs = durationMs;
      agentTask.completedAt = agentTask.completedAt || new Date().toISOString();

      // Record metrics
      agentDuration.observe({ project: projectName, agent_type: agentType }, durationMs / 1000);
      agentIterations.observe(
        { project: projectName, agent_type: agentType },
        agentTask.usage.iterations
      );
      agentTokensUsed.inc(
        { project: projectName, agent_type: agentType, type: 'total' },
        agentTask.usage.totalTokens
      );

      if (span?.setAttribute) {
        span.setAttribute('status', agentTask.status);
        span.setAttribute('iterations', agentTask.usage.iterations);
        span.setAttribute('tool_calls', agentTask.usage.toolCalls);
        span.setAttribute('duration_ms', durationMs);
      }
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
    agentTask: AgentTask,
    projectPath?: string
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

      agentTask.usage.totalTokens +=
        (response.promptTokens || 0) + (response.completionTokens || 0);

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
          observation = await this.executeAction(
            toolCall.name,
            toolCall.input,
            projectName,
            projectPath
          );
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

      // Check for convergence — early exit if observations are repetitive
      if (iteration >= 3 && this.hasConverged(agentTask.steps)) {
        messages.push({
          role: 'user',
          content:
            'Your recent observations are very similar. Please synthesize what you have found and provide a FINAL_ANSWER now.',
        });

        const finalResponse = await llm.chat(messages, {
          systemPrompt: profile.systemPrompt,
          tools: [], // No tools — force text-only response
          temperature: profile.temperature,
          maxTokens: 4096,
          think: true,
          provider: 'anthropic',
        });
        agentTask.usage.totalTokens +=
          (finalResponse.promptTokens || 0) + (finalResponse.completionTokens || 0);
        agentTask.usage.iterations = iteration + 1;
        return finalResponse.text;
      }
    }

    // Max iterations reached
    return (
      this.extractPartialResult(agentTask) ||
      'Agent reached maximum iterations without a final answer.'
    );
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
    agentTask: AgentTask,
    projectPath?: string
  ): Promise<string> {
    const deadline = Date.now() + timeout;

    // Build message history
    const messages: ChatMessage[] = [{ role: 'system', content: profile.systemPrompt }];

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

      agentTask.usage.totalTokens +=
        (response.promptTokens || 0) + (response.completionTokens || 0);

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
          step.action = {
            tool: parsed.action.tool,
            input: parsed.action.input,
            reasoning: parsed.thought,
          };
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
          observation = await this.executeAction(
            parsed.action.tool,
            parsed.action.input,
            projectName,
            projectPath
          );
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

        step.action = {
          tool: parsed.action.tool,
          input: parsed.action.input,
          reasoning: parsed.thought,
        };
        step.observation = { tool: parsed.action.tool, result: observation, truncated };
        agentTask.steps.push(step);

        // Add observation to history
        messages.push({ role: 'user', content: `OBSERVATION: ${observation}` });

        // Check for convergence — force synthesis if observations are repetitive
        if (iteration >= 3 && this.hasConverged(agentTask.steps)) {
          messages.push({
            role: 'user',
            content:
              'Your recent observations are very similar. Please synthesize what you have found and provide a FINAL_ANSWER now.',
          });

          const finalResponse = await llm.chat(messages, {
            temperature: profile.temperature,
            maxTokens: 4096,
            provider: 'ollama',
          });
          agentTask.usage.totalTokens +=
            (finalResponse.promptTokens || 0) + (finalResponse.completionTokens || 0);
          agentTask.usage.iterations = iteration + 1;

          const finalParsed = this.parseReactResponse(finalResponse.text);
          return finalParsed.finalAnswer || finalResponse.text;
        }
      } else {
        // No action and no final answer — nudge the agent
        agentTask.steps.push(step);
        messages.push({
          role: 'user',
          content:
            'No action or final answer detected. Please either use an ACTION or provide a FINAL_ANSWER.',
        });
      }
    }

    // Max iterations reached
    return (
      this.extractPartialResult(agentTask) ||
      'Agent reached maximum iterations without a final answer.'
    );
  }

  // ============================================
  // Response Parsing
  // ============================================

  private parseReactResponse(text: string): {
    thought: string;
    action?: { tool: string; input: Record<string, unknown> };
    finalAnswer?: string;
  } {
    const result: {
      thought: string;
      action?: { tool: string; input: Record<string, unknown> };
      finalAnswer?: string;
    } = {
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
    const inputMatch = text.match(
      /ACTION_INPUT:\s*([\s\S]*?)(?=\n(?:THOUGHT|ACTION|FINAL_ANSWER):|\s*$)/i
    );

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
    projectName: string,
    projectPath?: string
  ): Promise<string> {
    const executor = this.actionExecutors[tool];
    if (!executor) {
      throw new Error(`Unknown action: ${tool}`);
    }
    return executor(input, projectName, projectPath);
  }

  private actionExecutors: Record<
    string,
    (input: Record<string, unknown>, projectName: string, projectPath?: string) => Promise<string>
  > = {
    search_codebase: async (input, projectName, projectPath) => {
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

    recall_memory: async (input, projectName, projectPath) => {
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
        .map(
          (r, i) =>
            `[${i + 1}] [${r.memory.type}] ${r.memory.content} (score: ${r.score.toFixed(3)})`
        )
        .join('\n');
    },

    get_patterns: async (input, projectName, projectPath) => {
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

    get_adrs: async (input, projectName, projectPath) => {
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

    search_similar: async (input, projectName, projectPath) => {
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

    // ── Retrieval ──────────────────────────────────────────

    hybrid_search: async (input, projectName, projectPath) => {
      const query = String(input.query || '');
      const limit = Number(input.limit) || 5;
      const collection = `${projectName}_codebase`;

      let results;
      if (config.SPARSE_VECTORS_ENABLED) {
        const { dense, sparse } = await embeddingService.embedFull(query);
        results = await vectorStore.searchHybridNative(collection, dense, sparse, limit);
      } else {
        const embedding = await embeddingService.embed(query);
        results = await vectorStore.search(collection, embedding, limit);
      }

      if (results.length === 0) return 'No results found.';
      return results
        .map((r, i) => {
          const file = r.payload.file || 'unknown';
          const content = String(r.payload.content || '').slice(0, 500);
          return `[${i + 1}] ${file} (score: ${r.score.toFixed(3)})\n${content}`;
        })
        .join('\n\n');
    },

    search_docs: async (input, projectName, projectPath) => {
      const query = String(input.query || '');
      const limit = Number(input.limit) || 3;
      const collection = `${projectName}_docs`;
      try {
        const embedding = await embeddingService.embed(query);
        const results = await vectorStore.search(collection, embedding, limit);
        if (results.length === 0) return 'No documentation found.';
        return results
          .map((r, i) => {
            const file = r.payload.file || 'unknown';
            const content = String(r.payload.content || '').slice(0, 500);
            return `[${i + 1}] ${file} (score: ${r.score.toFixed(3)})\n${content}`;
          })
          .join('\n\n');
      } catch (e: any) {
        if (e.status === 404) return 'No docs collection found.';
        throw e;
      }
    },

    // ── Graph ──────────────────────────────────────────────

    search_graph: async (input, projectName, projectPath) => {
      const files = Array.isArray(input.files)
        ? (input.files as string[])
        : [String(input.file || input.query || '')];
      const hops = Number(input.hops) || 1;
      const expanded = await graphStore.expand(projectName, files.slice(0, 5), hops);
      if (expanded.length === 0) return 'No graph dependencies found.';
      const deps = expanded.filter((f) => !files.includes(f));

      // Enhancement: LSP call hierarchy for real-time accuracy
      if (config.LSP_ENABLED && projectPath && files[0]) {
        try {
          const { lspClient } = await import('./lsp-client');
          const absFile = path.join(projectPath, files[0]);
          const symbols = await lspClient.documentSymbol(absFile, projectPath);
          if (symbols) {
            // Get incoming/outgoing calls for top callable symbols (kind 6=Method, 12=Function)
            const callableSymbols = symbols.filter((s) => [6, 12].includes(s.kind)).slice(0, 10);
            for (const sym of callableSymbols) {
              const [incoming, outgoing] = await Promise.all([
                lspClient.incomingCalls(absFile, sym.startLine, 0, projectPath),
                lspClient.outgoingCalls(absFile, sym.startLine, 0, projectPath),
              ]);
              for (const call of [...(incoming || []), ...(outgoing || [])]) {
                const relFile = path.relative(projectPath, call.file).replace(/\\/g, '/');
                if (!expanded.includes(relFile)) {
                  expanded.push(relFile);
                }
              }
            }
          }
        } catch {
          /* LSP enrichment is best-effort */
        }
      }

      return `Files: ${files.join(', ')}\nDependencies (${deps.length}):\n${deps.map((f) => `  - ${f}`).join('\n')}`;
    },

    find_symbol: async (input, projectName, projectPath) => {
      const name = String(input.name || input.query || '');
      const kind = input.kind ? String(input.kind) : undefined;
      const limit = Number(input.limit) || 5;
      const resolvedPath =
        (input.projectPath ? String(input.projectPath) : undefined) ?? projectPath;
      const results = resolvedPath
        ? await symbolIndex.findSymbolEnriched(projectName, name, kind, limit, resolvedPath)
        : await symbolIndex.findSymbol(projectName, name, kind, limit);
      if (results.length === 0) return `Symbol "${name}" not found.`;
      return results
        .map((r, i) => `[${i + 1}] ${r.kind} ${r.name} in ${r.file}:${r.startLine || '?'}`)
        .join('\n');
    },

    // ── Memory ─────────────────────────────────────────────

    remember: async (input, projectName, projectPath) => {
      const content = String(input.content || '');
      const type = String(input.type || 'note');
      const tags = Array.isArray(input.tags) ? (input.tags as string[]) : [];
      await memoryService.remember({
        projectName,
        content,
        type: type as any,
        tags,
      });
      return `Remembered: ${content.slice(0, 100)}`;
    },

    list_memories: async (input, projectName, projectPath) => {
      const type = input.type ? String(input.type) : undefined;
      const limit = Number(input.limit) || 10;
      const results = await memoryService.list({ projectName, type: type as any, limit });
      if (results.length === 0) return 'No memories found.';
      return results
        .map((m: any, i: number) => `[${i + 1}] [${m.type}] ${String(m.content).slice(0, 150)}`)
        .join('\n');
    },

    // ── Analysis ───────────────────────────────────────────

    explain_code: async (input, projectName, projectPath) => {
      const query = String(input.query || input.code || '');
      // Search for relevant code first
      const embedding = await embeddingService.embed(query);
      const searchResults = await vectorStore.search(`${projectName}_codebase`, embedding, 3);
      const codeContext = searchResults
        .map((r) => `File: ${r.payload.file}\n${String(r.payload.content || '').slice(0, 800)}`)
        .join('\n\n---\n\n');

      // Enhancement: LSP hover for type info
      let typeContext = '';
      if (config.LSP_ENABLED && projectPath) {
        try {
          const { lspClient } = await import('./lsp-client');
          for (const result of searchResults.slice(0, 2)) {
            const file = result.payload?.file as string;
            if (!file) continue;
            const absFile = path.join(projectPath, file);
            const symbols = await lspClient.documentSymbol(absFile, projectPath);
            if (symbols) {
              const hovers = await Promise.all(
                symbols
                  .slice(0, 5)
                  .map((s) =>
                    lspClient.hover(absFile, s.startLine, 0, projectPath).catch(() => null)
                  )
              );
              const valid = hovers.filter(Boolean);
              if (valid.length > 0) {
                typeContext =
                  'Type information:\n' + valid.map((h) => h!.content).join('\n') + '\n\n';
              }
            }
          }
        } catch {
          /* best effort */
        }
      }

      const fullContext = typeContext + codeContext;

      const explanation = await llm.complete(
        `Explain this code in the context of the project:\n\nQuery: ${query}\n\n${fullContext}`,
        {
          systemPrompt:
            'You are a code explanation assistant. Be concise and focus on the key concepts.',
          maxTokens: 1024,
          temperature: 0.3,
          think: false,
        }
      );
      return explanation.text;
    },
  };

  // ============================================
  // Convergence Detection
  // ============================================

  /**
   * Detect if agent observations have converged (same info being retrieved).
   * Uses Jaccard similarity on observation content hashes across a sliding window.
   * Returns true if the last `windowSize` iterations all have similarity >= threshold.
   */
  private hasConverged(
    steps: AgentStep[],
    windowSize: number = 3,
    threshold: number = 0.7
  ): boolean {
    if (steps.length < windowSize) return false;

    // Extract token sets from observations in the window
    const window = steps.slice(-windowSize);
    const tokenSets = window.map((step) => {
      const text = step.observation?.result || step.thought || '';
      return new Set(
        text
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 3)
      );
    });

    // Pairwise Jaccard similarity — all pairs must exceed threshold
    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        const a = tokenSets[i];
        const b = tokenSets[j];
        if (a.size === 0 && b.size === 0) continue;

        let intersection = 0;
        for (const token of a) {
          if (b.has(token)) intersection++;
        }
        const union = a.size + b.size - intersection;
        const similarity = union > 0 ? intersection / union : 0;

        if (similarity < threshold) return false;
      }
    }

    logger.info('Agent convergence detected', {
      iterations: steps.length,
      windowSize,
      threshold,
    });
    return true;
  }

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
