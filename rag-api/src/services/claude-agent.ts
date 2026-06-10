/**
 * Claude Agent Service — Autonomous agents powered by Claude Agent SDK.
 *
 * Runs Claude Code as a subprocess with tool access (Read, Write, Edit, Bash, Glob, Grep)
 * and connects the RAG MCP server for codebase knowledge (search, memory, patterns, ADRs).
 *
 * Separate from agent-runtime.ts (ReAct/tool_use agents that run in-process).
 * This service spawns a full Claude Code instance with file system access.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultSuccess,
  type SDKResultError,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import config from '../config';
import { logger } from '../utils/logger';
import { workRegistry } from './work-handler';
import { smartDispatch } from './smart-dispatch';
import { agentRuntime } from './agent-runtime';
import { tribunalService } from './tribunal';
import { withSpan } from '../utils/tracing';

// ============================================
// Types
// ============================================

export type AutonomousAgentType = 'research' | 'review' | 'implement' | 'test' | 'refactor';

export interface AutonomousAgentOptions {
  projectName: string;
  projectPath: string;
  task: string;
  type: AutonomousAgentType;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  includeStreaming?: boolean;
}

export interface AutonomousAgentResult {
  id: string;
  type: AutonomousAgentType;
  task: string;
  projectName: string;
  status: 'completed' | 'failed' | 'budget_exceeded' | 'interrupted';
  result?: string;
  error?: string;
  cost?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  numTurns?: number;
  durationMs?: number;
  sessionId?: string;
  messages?: SDKMessage[];
}

// ============================================
// Agent Type Configurations
// ============================================

const AGENT_CONFIGS: Record<
  AutonomousAgentType,
  {
    systemPrompt: string;
    tools: string[];
    permissionMode: Options['permissionMode'];
    defaultMaxTurns: number;
    defaultBudget: number;
  }
> = {
  research: {
    systemPrompt: `You are a research agent. Investigate the codebase thoroughly to answer the user's question.
Use RAG tools (search_codebase, recall, get_patterns, get_adrs) to find relevant code and context.
Use Read, Glob, and Grep to examine specific files.
Provide a comprehensive analysis with file references and code snippets.`,
    tools: ['Read', 'Glob', 'Grep', 'mcp__rag__*'],
    permissionMode: 'default',
    defaultMaxTurns: 15,
    defaultBudget: 1.0,
  },

  review: {
    systemPrompt: `You are a code review agent. Review code for bugs, security issues, performance problems, and style.
Use RAG tools to fetch project patterns and ADRs for context-aware review.
Use Read, Glob, and Grep to examine the codebase.
Provide structured feedback with severity levels and specific suggestions.`,
    tools: ['Read', 'Glob', 'Grep', 'mcp__rag__*'],
    permissionMode: 'default',
    defaultMaxTurns: 20,
    defaultBudget: 2.0,
  },

  implement: {
    systemPrompt: `You are an implementation agent. Write code following project patterns and conventions.
Use RAG tools to understand existing patterns, ADRs, and codebase structure before writing.
Use Read, Edit, Write, Glob, Grep to modify the codebase.
Use Bash to run builds and tests after changes.
Follow existing code style and conventions.`,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'mcp__rag__*'],
    permissionMode: 'acceptEdits',
    defaultMaxTurns: 30,
    defaultBudget: 5.0,
  },

  test: {
    systemPrompt: `You are a testing agent. Write and run tests for the codebase.
Use RAG tools to understand existing test patterns and conventions.
Use Read, Write, Edit to create/modify test files.
Use Bash to run tests and verify they pass.
Follow the project's existing test framework and style.`,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'mcp__rag__*'],
    permissionMode: 'acceptEdits',
    defaultMaxTurns: 25,
    defaultBudget: 3.0,
  },

  refactor: {
    systemPrompt: `You are a refactoring agent. Improve code quality without changing behavior.
Use RAG tools to understand project patterns and identify code smells.
Use Read, Edit, Glob, Grep to examine and modify code.
Use Bash to run tests after refactoring to ensure nothing breaks.
Make incremental, safe changes.`,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'mcp__rag__*'],
    permissionMode: 'acceptEdits',
    defaultMaxTurns: 25,
    defaultBudget: 3.0,
  },
};

// ============================================
// Service
// ============================================

class ClaudeAgentService {
  private mcpServerPath: string;
  private activeAgents: Map<string, AbortController> = new Map();

  constructor() {
    // Resolve MCP server path relative to this project
    this.mcpServerPath = path.resolve(__dirname, '../../../mcp-server/dist/index.js');
  }

  /**
   * Run an autonomous Claude agent.
   */
  async run(options: AutonomousAgentOptions): Promise<AutonomousAgentResult> {
    return withSpan(
      'claude_agent.run',
      {
        type: options.type,
        project: options.projectName,
        task: options.task.slice(0, 100),
      },
      async () => this._run(options)
    );
  }

  private async _run(options: AutonomousAgentOptions): Promise<AutonomousAgentResult> {
    const agentId = uuidv4();
    const agentConfig = AGENT_CONFIGS[options.type];
    const startTime = Date.now();

    const abortController = new AbortController();
    this.activeAgents.set(agentId, abortController);

    // Register in work registry with cancel support
    const workHandle = workRegistry.register({
      id: agentId,
      type: 'claude-agent',
      projectName: options.projectName,
      description: `Claude ${options.type}: ${options.task.slice(0, 100)}`,
      cancelFn: () => abortController.abort(),
      metadata: { agentType: options.type },
    });

    logger.info('Starting autonomous agent', {
      agentId,
      type: options.type,
      project: options.projectName,
      task: options.task.slice(0, 100),
    });

    const messages: SDKMessage[] = [];

    try {
      // Build MCP server config for RAG access
      const mcpServers: Record<string, McpServerConfig> = {
        rag: {
          command: 'node',
          args: [this.mcpServerPath],
          env: {
            PROJECT_NAME: options.projectName,
            PROJECT_PATH: options.projectPath,
            RAG_API_URL: `http://localhost:${config.API_PORT}`,
          },
        },
      };

      // Build allowed tools list
      const allowedTools = [...agentConfig.tools];

      const queryOptions: Options = {
        abortController,
        cwd: options.projectPath,
        tools: allowedTools.filter((t) => !t.startsWith('mcp__')),
        allowedTools,
        permissionMode: agentConfig.permissionMode,
        mcpServers,
        model: options.model || config.ANTHROPIC_MODEL,
        effort: options.effort || (config.CLAUDE_EFFORT as Options['effort']),
        maxTurns: options.maxTurns ?? agentConfig.defaultMaxTurns,
        maxBudgetUsd: options.maxBudgetUsd ?? agentConfig.defaultBudget,
        thinking: { type: 'adaptive' },
        persistSession: false,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY || '',
          CLAUDECODE: '',
        },
      };

      // Build prompt with system context
      const prompt = `${agentConfig.systemPrompt}\n\nProject: ${options.projectName}\nPath: ${options.projectPath}\n\nTask: ${options.task}`;

      let result: AutonomousAgentResult = {
        id: agentId,
        type: options.type,
        task: options.task,
        projectName: options.projectName,
        status: 'failed',
      };

      // Run the query and collect messages
      for await (const message of query({ prompt, options: queryOptions })) {
        if (options.includeStreaming) {
          messages.push(message);
        }

        // Capture result message
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            const successMsg = message as SDKResultSuccess;
            result = {
              id: agentId,
              type: options.type,
              task: options.task,
              projectName: options.projectName,
              status: 'completed',
              result: successMsg.result,
              cost: successMsg.total_cost_usd,
              usage: {
                inputTokens: successMsg.usage.input_tokens,
                outputTokens: successMsg.usage.output_tokens,
                totalTokens: successMsg.usage.input_tokens + successMsg.usage.output_tokens,
              },
              numTurns: successMsg.num_turns,
              durationMs: successMsg.duration_ms,
              sessionId: successMsg.session_id,
            };
          } else {
            // Error result
            const errorMsg = message as SDKResultError;
            result = {
              id: agentId,
              type: options.type,
              task: options.task,
              projectName: options.projectName,
              status: errorMsg.subtype === 'error_max_budget_usd' ? 'budget_exceeded' : 'failed',
              error: errorMsg.errors?.join('; ') || 'Agent failed',
              durationMs: errorMsg.duration_ms,
              sessionId: errorMsg.session_id,
            };
          }
        }
      }

      if (options.includeStreaming) {
        result.messages = messages;
      }

      result.durationMs = result.durationMs || Date.now() - startTime;

      logger.info('Autonomous agent completed', {
        agentId,
        status: result.status,
        cost: result.cost,
        turns: result.numTurns,
        durationMs: result.durationMs,
      });

      if (result.status === 'completed') {
        workHandle.complete({ cost: result.cost, turns: result.numTurns });
      } else {
        workHandle.fail(result.error || result.status);
      }

      return result;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      if (error.name === 'AbortError') {
        logger.info('Autonomous agent interrupted', { agentId, durationMs });
        workHandle.update({ state: 'cancelled' });
        return {
          id: agentId,
          type: options.type,
          task: options.task,
          projectName: options.projectName,
          status: 'interrupted',
          error: 'Agent was interrupted',
          durationMs,
        };
      }

      logger.error('Autonomous agent failed', {
        agentId,
        error: error.message,
        durationMs,
      });
      workHandle.fail(error.message);

      return {
        id: agentId,
        type: options.type,
        task: options.task,
        projectName: options.projectName,
        status: 'failed',
        error: error.message,
        durationMs,
      };
    } finally {
      this.activeAgents.delete(agentId);
    }
  }

  /**
   * Stop a running autonomous agent.
   */
  stop(agentId: string): boolean {
    const controller = this.activeAgents.get(agentId);
    if (controller) {
      controller.abort();
      this.activeAgents.delete(agentId);
      return true;
    }
    return false;
  }

  /**
   * List currently running agents.
   */
  getRunningAgents(): string[] {
    return Array.from(this.activeAgents.keys());
  }

  /**
   * Get available autonomous agent types.
   */
  getAgentTypes(): Array<{
    type: AutonomousAgentType;
    description: string;
    defaultBudget: number;
  }> {
    return Object.entries(AGENT_CONFIGS).map(([type, cfg]) => ({
      type: type as AutonomousAgentType,
      description: cfg.systemPrompt.split('\n')[0],
      defaultBudget: cfg.defaultBudget,
    }));
  }

  /**
   * Run a multi-step workflow that chains orchestrators.
   *
   * Steps are grouped by `parallel` field — steps in the same group run via Promise.all,
   * groups execute sequentially. Each step's result is stored in WorkflowContext.results[step.id].
   */
  async runWorkflow(options: {
    projectName: string;
    projectPath: string;
    steps: WorkflowStep[];
  }): Promise<WorkflowResult> {
    return withSpan(
      'claude_agent.workflow',
      {
        project: options.projectName,
        step_count: options.steps.length,
        steps: options.steps.map((s) => s.id).join(','),
      },
      async () => this._runWorkflow(options)
    );
  }

  private async _runWorkflow(options: {
    projectName: string;
    projectPath: string;
    steps: WorkflowStep[];
  }): Promise<WorkflowResult> {
    const workflowId = uuidv4();
    const startTime = Date.now();
    const { projectName, projectPath, steps } = options;

    const context: WorkflowContext = {
      results: {},
      completedSteps: [],
      projectName,
      projectPath,
    };

    const workHandle = workRegistry.register({
      id: workflowId,
      type: 'agent',
      projectName,
      description: `Workflow: ${steps.map((s) => s.id).join(' → ')}`,
      metadata: { stepCount: steps.length },
    });

    const stepTimings: Record<string, number> = {};

    try {
      // Group steps: steps with same `parallel` value run together, others run alone
      const groups = this.groupWorkflowSteps(steps);

      for (const group of groups) {
        // Filter out steps whose condition returns false
        const runnableSteps = group.filter((step) => !step.condition || step.condition(context));

        if (runnableSteps.length === 0) continue;

        // Execute group in parallel
        const groupResults = await Promise.all(
          runnableSteps.map(async (step) => {
            const stepStart = Date.now();
            const stepConfig = step.transform
              ? { ...step.config, ...step.transform(context) }
              : step.config;

            try {
              const result = await this.executeWorkflowStep(step.type, stepConfig, context);
              stepTimings[step.id] = Date.now() - stepStart;
              return { id: step.id, result, error: undefined };
            } catch (error: any) {
              stepTimings[step.id] = Date.now() - stepStart;
              return { id: step.id, result: undefined, error: error.message };
            }
          })
        );

        for (const { id, result, error } of groupResults) {
          context.results[id] = error ? { error } : result;
          context.completedSteps.push(id);
        }

        workHandle.update({
          progress: {
            current: context.completedSteps.length,
            total: steps.length,
            percentage: Math.round((context.completedSteps.length / steps.length) * 100),
          },
        });
      }

      workHandle.complete({ stepsCompleted: context.completedSteps.length });

      return {
        id: workflowId,
        status: 'completed',
        results: context.results,
        completedSteps: context.completedSteps,
        stepTimings,
        durationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      workHandle.fail(error.message);
      return {
        id: workflowId,
        status: 'failed',
        results: context.results,
        completedSteps: context.completedSteps,
        stepTimings,
        error: error.message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Group steps: steps sharing the same `parallel` ID run together.
   * Steps without `parallel` run in their own group, preserving order.
   */
  private groupWorkflowSteps(steps: WorkflowStep[]): WorkflowStep[][] {
    const groups: WorkflowStep[][] = [];
    const parallelGroups = new Map<string, WorkflowStep[]>();
    const order: (string | number)[] = []; // track insertion order

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.parallel) {
        if (!parallelGroups.has(step.parallel)) {
          parallelGroups.set(step.parallel, []);
          order.push(step.parallel);
        }
        parallelGroups.get(step.parallel)!.push(step);
      } else {
        order.push(i);
      }
    }

    for (const key of order) {
      if (typeof key === 'string') {
        const group = parallelGroups.get(key);
        if (group && group.length > 0) {
          groups.push(group);
          parallelGroups.delete(key); // only emit once
        }
      } else {
        groups.push([steps[key]]);
      }
    }

    return groups;
  }

  /**
   * Execute a single workflow step by type.
   */
  private async executeWorkflowStep(
    type: WorkflowStep['type'],
    stepConfig: Record<string, unknown>,
    context: WorkflowContext
  ): Promise<unknown> {
    switch (type) {
      case 'smart_dispatch':
        return smartDispatch.dispatch({
          projectName: context.projectName,
          task: String(stepConfig.task || ''),
          files: stepConfig.files as string[] | undefined,
          intent: stepConfig.intent as any,
        });

      case 'agent':
        return agentRuntime.run({
          projectName: context.projectName,
          agentType: String(stepConfig.type || stepConfig.agentType || 'research'),
          task: String(stepConfig.task || ''),
          context: stepConfig.context as string | undefined,
        });

      case 'tribunal':
        return tribunalService.debate({
          projectName: context.projectName,
          topic: String(stepConfig.topic || ''),
          positions: (stepConfig.positions as string[]) || [],
          context: stepConfig.context as string | undefined,
          maxRounds: stepConfig.maxRounds as number | undefined,
          useCodeContext: stepConfig.useCodeContext as boolean | undefined,
          autoRecord: stepConfig.autoRecord as boolean | undefined,
          maxBudget: stepConfig.maxBudget as number | undefined,
        });

      case 'claude_agent':
        return this.run({
          projectName: context.projectName,
          projectPath: context.projectPath,
          type: (stepConfig.type || 'research') as AutonomousAgentType,
          task: String(stepConfig.task || ''),
          maxTurns: stepConfig.maxTurns as number | undefined,
          maxBudgetUsd: stepConfig.maxBudgetUsd as number | undefined,
        });

      default:
        throw new Error(`Unknown workflow step type: ${type}`);
    }
  }
}

// ============================================
// Workflow Types
// ============================================

export interface WorkflowStep {
  id: string;
  type: 'smart_dispatch' | 'agent' | 'tribunal' | 'claude_agent';
  config: Record<string, unknown>;
  parallel?: string; // group ID — steps in same group run via Promise.all
  condition?: (context: WorkflowContext) => boolean;
  transform?: (context: WorkflowContext) => Record<string, unknown>;
}

export interface WorkflowContext {
  results: Record<string, unknown>;
  completedSteps: string[];
  projectName: string;
  projectPath: string;
}

export interface WorkflowResult {
  id: string;
  status: 'completed' | 'failed';
  results: Record<string, unknown>;
  completedSteps: string[];
  stepTimings: Record<string, number>;
  error?: string;
  durationMs: number;
}

export const claudeAgentService = new ClaudeAgentService();
export default claudeAgentService;
