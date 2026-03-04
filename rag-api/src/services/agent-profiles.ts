/**
 * Agent Profiles - Specialized agent configurations for the ReAct runtime.
 *
 * Each profile defines a system prompt, allowed actions, and limits
 * for a specific type of autonomous agent.
 *
 * Also provides Claude tool definitions for native tool_use mode.
 */

import Anthropic from '@anthropic-ai/sdk';
import config from '../config';

export interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  allowedActions: string[];
  outputFormat: 'markdown' | 'json';
  maxIterations: number;
  timeout: number;
  temperature: number;
}

const REACT_FORMAT_INSTRUCTIONS = `You are an AI agent using the ReAct (Reasoning + Acting) framework.

For each step, output in EXACTLY this format:

THOUGHT: <brief plan for next action>
ACTION: <tool_name>
ACTION_INPUT: <JSON input for the tool>

After receiving an observation, continue with the next step.

When you have enough information, output:

THOUGHT: <final reasoning>
FINAL_ANSWER: <your complete answer>

Rules:
- Always start with THOUGHT
- Use only the tools listed in your allowed actions
- Each ACTION must be followed by exactly one ACTION_INPUT (valid JSON)
- When you have enough info, always end with FINAL_ANSWER
- Be thorough but efficient — minimize unnecessary tool calls`;

const CLAUDE_AGENT_INSTRUCTIONS = `You are an AI agent that investigates and analyzes codebases.

Use the provided tools to gather information, then synthesize a comprehensive answer.
When you have enough information, respond with your final analysis as plain text (no tool calls).

Guidelines:
- Be thorough but efficient — minimize unnecessary tool calls
- Use multiple tools when different aspects need investigation
- Cite file paths and specific findings in your answer
- When you have enough context, give your final answer directly`;

export const agentProfiles: Record<string, AgentProfile> = {
  research: {
    name: 'research',
    description: 'Investigates the codebase, finds patterns, and synthesizes analysis. Best for understanding how things work.',
    systemPrompt: config.LLM_PROVIDER === 'anthropic'
      ? `${CLAUDE_AGENT_INSTRUCTIONS}

You are a Research Agent. Thoroughly investigate the codebase to answer questions.

Your answer should include:
- Key findings with file references
- Relevant patterns or conventions discovered
- Connections between different parts of the codebase`
      : `${REACT_FORMAT_INSTRUCTIONS}

You are a Research Agent. Thoroughly investigate the codebase to answer questions.

Your answer should include:
- Key findings with file references
- Relevant patterns or conventions discovered
- Connections between different parts of the codebase`,
    allowedActions: ['search_codebase', 'recall_memory', 'get_patterns', 'get_adrs', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 15 : 10,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  review: {
    name: 'review',
    description: 'Reviews code against project patterns, ADRs, and best practices. Identifies issues and improvements.',
    systemPrompt: config.LLM_PROVIDER === 'anthropic'
      ? `${CLAUDE_AGENT_INSTRUCTIONS}

You are a Code Review Agent. Review code against project standards and conventions.

Your answer should include:
- Pattern compliance assessment
- Specific issues found (with severity)
- Suggested improvements
- Positive aspects of the code`
      : `${REACT_FORMAT_INSTRUCTIONS}

You are a Code Review Agent. Review code against project standards and conventions.

Your answer should include:
- Pattern compliance assessment
- Specific issues found (with severity)
- Suggested improvements
- Positive aspects of the code`,
    allowedActions: ['recall_memory', 'get_patterns', 'get_adrs', 'search_codebase', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 12 : 6,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.2,
  },

  documentation: {
    name: 'documentation',
    description: 'Analyzes code and generates documentation. Understands context through codebase exploration.',
    systemPrompt: config.LLM_PROVIDER === 'anthropic'
      ? `${CLAUDE_AGENT_INSTRUCTIONS}

You are a Documentation Agent. Analyze code and produce clear documentation.

Your answer should include:
- Overview of what the code does
- Key interfaces/types explained
- Usage examples where applicable
- Dependencies and relationships`
      : `${REACT_FORMAT_INSTRUCTIONS}

You are a Documentation Agent. Analyze code and produce clear documentation.

Your answer should include:
- Overview of what the code does
- Key interfaces/types explained
- Usage examples where applicable
- Dependencies and relationships`,
    allowedActions: ['search_codebase', 'recall_memory', 'get_patterns', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 10 : 6,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  refactor: {
    name: 'refactor',
    description: 'Finds code smells and suggests refactoring based on project patterns and best practices.',
    systemPrompt: config.LLM_PROVIDER === 'anthropic'
      ? `${CLAUDE_AGENT_INSTRUCTIONS}

You are a Refactoring Agent. Identify code smells and suggest improvements.

Your answer should include:
- Code smells identified (with locations)
- Recommended refactoring approach
- Expected benefits
- Risk assessment`
      : `${REACT_FORMAT_INSTRUCTIONS}

You are a Refactoring Agent. Identify code smells and suggest improvements.

Your answer should include:
- Code smells identified (with locations)
- Recommended refactoring approach
- Expected benefits
- Risk assessment`,
    allowedActions: ['search_codebase', 'recall_memory', 'get_patterns', 'get_adrs', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 12 : 8,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  test: {
    name: 'test',
    description: 'Generates test strategies based on codebase patterns. Identifies what and how to test.',
    systemPrompt: config.LLM_PROVIDER === 'anthropic'
      ? `${CLAUDE_AGENT_INSTRUCTIONS}

You are a Testing Agent. Create test strategies based on project patterns.

Your answer should include:
- Test types needed (unit, integration, e2e)
- Key test cases with descriptions
- Mocking strategy
- Edge cases to cover`
      : `${REACT_FORMAT_INSTRUCTIONS}

You are a Testing Agent. Create test strategies based on project patterns.

Your answer should include:
- Test types needed (unit, integration, e2e)
- Key test cases with descriptions
- Mocking strategy
- Edge cases to cover`,
    allowedActions: ['search_codebase', 'recall_memory', 'get_patterns', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 10 : 6,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },
};

export function getAgentProfile(type: string): AgentProfile | undefined {
  return agentProfiles[type];
}

export function listAgentTypes(): Array<{ name: string; description: string }> {
  return Object.values(agentProfiles).map(p => ({
    name: p.name,
    description: p.description,
  }));
}

// ============================================
// Claude Tool Definitions
// ============================================

/**
 * Map of action names to Claude tool definitions (JSON schema).
 */
const TOOL_DEFINITIONS: Record<string, Anthropic.Tool> = {
  search_codebase: {
    name: 'search_codebase',
    description: 'Search the codebase for relevant source code by semantic similarity. Returns matching code snippets with file paths and relevance scores.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query describing what to find in the codebase',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: ['query'],
    },
  },

  recall_memory: {
    name: 'recall_memory',
    description: 'Recall memories from past sessions — decisions, bugs, context, insights. Useful for understanding prior work and avoiding repeated mistakes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in memory',
        },
        type: {
          type: 'string',
          description: 'Memory type filter: all, context, decision, insight',
          enum: ['all', 'context', 'decision', 'insight'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: ['query'],
    },
  },

  get_patterns: {
    name: 'get_patterns',
    description: 'Get architectural patterns and coding conventions used in the project. Useful for ensuring consistency.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Pattern topic to search for',
        },
      },
      required: ['query'],
    },
  },

  get_adrs: {
    name: 'get_adrs',
    description: 'Get Architecture Decision Records (ADRs) — past decisions about design, technology choices, and trade-offs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Decision topic to search for',
        },
      },
      required: ['query'],
    },
  },

  search_similar: {
    name: 'search_similar',
    description: 'Find code similar to a given snippet. Useful for finding duplicates, related implementations, or patterns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'Code snippet to find similar code for',
        },
        query: {
          type: 'string',
          description: 'Alternative: text query to find similar code',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: [],
    },
  },
};

/**
 * Get Claude tool definitions for a given set of allowed actions.
 */
export function getToolDefinitions(allowedActions: string[]): Anthropic.Tool[] {
  return allowedActions
    .filter(action => TOOL_DEFINITIONS[action])
    .map(action => TOOL_DEFINITIONS[action]);
}
