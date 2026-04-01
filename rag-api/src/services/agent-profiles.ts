/**
 * Agent Profiles - Specialized agent configurations for the ReAct runtime.
 *
 * Each profile defines a system prompt, allowed actions, and limits
 * for a specific type of autonomous agent.
 *
 * Also provides Claude tool definitions for native tool_use mode.
 */

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import config from '../config';
import { logger } from '../utils/logger';

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

// ── Template Loading ──────────────────────────────────────────

const TEMPLATES_DIR = path.resolve(__dirname, '../../templates/agents');

function loadTemplate(name: string): string | null {
  try {
    const filePath = path.join(TEMPLATES_DIR, `${name}.md`);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch (error: any) {
    logger.debug(`Failed to load agent template: ${name}`, { error: error.message });
  }
  return null;
}

/** Build system prompt: base instructions + template (if available) + inline fallback */
function buildSystemPrompt(agentName: string, inlinePrompt: string): string {
  const template = loadTemplate(agentName);
  const base =
    config.LLM_PROVIDER === 'anthropic' ? CLAUDE_AGENT_INSTRUCTIONS : REACT_FORMAT_INSTRUCTIONS;

  if (template) {
    return `${base}\n\n${template}`;
  }
  return inlinePrompt;
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
    description:
      'Investigates the codebase, finds patterns, and synthesizes analysis. Best for understanding how things work.',
    systemPrompt: buildSystemPrompt(
      'research',
      config.LLM_PROVIDER === 'anthropic'
        ? `${CLAUDE_AGENT_INSTRUCTIONS}\n\nYou are a Research Agent. Thoroughly investigate the codebase to answer questions.\n\nYour answer should include:\n- Key findings with file references\n- Relevant patterns or conventions discovered\n- Connections between different parts of the codebase`
        : `${REACT_FORMAT_INSTRUCTIONS}\n\nYou are a Research Agent. Thoroughly investigate the codebase to answer questions.\n\nYour answer should include:\n- Key findings with file references\n- Relevant patterns or conventions discovered\n- Connections between different parts of the codebase`
    ),
    allowedActions: [
      'search_codebase',
      'recall_memory',
      'get_patterns',
      'get_adrs',
      'search_similar',
      'hybrid_search',
      'search_graph',
      'find_symbol',
      'search_docs',
    ],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 15 : 10,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  review: {
    name: 'review',
    description:
      'Reviews code against project patterns, ADRs, and best practices. Identifies issues and improvements.',
    systemPrompt: buildSystemPrompt(
      'review',
      config.LLM_PROVIDER === 'anthropic'
        ? `${CLAUDE_AGENT_INSTRUCTIONS}\n\nYou are a Code Review Agent. Review code against project standards and conventions.\n\nYour answer should include:\n- Pattern compliance assessment\n- Specific issues found (with severity)\n- Suggested improvements\n- Positive aspects of the code`
        : `${REACT_FORMAT_INSTRUCTIONS}\n\nYou are a Code Review Agent. Review code against project standards and conventions.\n\nYour answer should include:\n- Pattern compliance assessment\n- Specific issues found (with severity)\n- Suggested improvements\n- Positive aspects of the code`
    ),
    allowedActions: [
      'recall_memory',
      'get_patterns',
      'get_adrs',
      'search_codebase',
      'search_similar',
      'hybrid_search',
      'search_graph',
      'find_symbol',
    ],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 12 : 6,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.2,
  },

  documentation: {
    name: 'documentation',
    description:
      'Analyzes code and generates documentation. Understands context through codebase exploration.',
    systemPrompt: buildSystemPrompt(
      'documentation',
      config.LLM_PROVIDER === 'anthropic'
        ? `${CLAUDE_AGENT_INSTRUCTIONS}\n\nYou are a Documentation Agent. Analyze code and produce clear documentation.\n\nYour answer should include:\n- Overview of what the code does\n- Key interfaces/types explained\n- Usage examples where applicable\n- Dependencies and relationships`
        : `${REACT_FORMAT_INSTRUCTIONS}\n\nYou are a Documentation Agent. Analyze code and produce clear documentation.\n\nYour answer should include:\n- Overview of what the code does\n- Key interfaces/types explained\n- Usage examples where applicable\n- Dependencies and relationships`
    ),
    allowedActions: [
      'search_codebase',
      'recall_memory',
      'get_patterns',
      'search_similar',
      'search_docs',
      'find_symbol',
    ],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 10 : 6,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  refactor: {
    name: 'refactor',
    description:
      'Finds code smells and suggests refactoring based on project patterns and best practices.',
    systemPrompt: buildSystemPrompt(
      'refactor',
      config.LLM_PROVIDER === 'anthropic'
        ? `${CLAUDE_AGENT_INSTRUCTIONS}\n\nYou are a Refactoring Agent. Identify code smells and suggest improvements.\n\nYour answer should include:\n- Code smells identified (with locations)\n- Recommended refactoring approach\n- Expected benefits\n- Risk assessment`
        : `${REACT_FORMAT_INSTRUCTIONS}\n\nYou are a Refactoring Agent. Identify code smells and suggest improvements.\n\nYour answer should include:\n- Code smells identified (with locations)\n- Recommended refactoring approach\n- Expected benefits\n- Risk assessment`
    ),
    allowedActions: [
      'search_codebase',
      'recall_memory',
      'get_patterns',
      'get_adrs',
      'search_similar',
      'search_graph',
      'find_symbol',
      'remember',
    ],
    outputFormat: 'markdown',
    maxIterations: config.LLM_PROVIDER === 'anthropic' ? 12 : 8,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  test: {
    name: 'test',
    description:
      'Generates test strategies based on codebase patterns. Identifies what and how to test.',
    systemPrompt: buildSystemPrompt(
      'test',
      config.LLM_PROVIDER === 'anthropic'
        ? `${CLAUDE_AGENT_INSTRUCTIONS}\n\nYou are a Testing Agent. Create test strategies based on project patterns.\n\nYour answer should include:\n- Test types needed (unit, integration, e2e)\n- Key test cases with descriptions\n- Mocking strategy\n- Edge cases to cover`
        : `${REACT_FORMAT_INSTRUCTIONS}\n\nYou are a Testing Agent. Create test strategies based on project patterns.\n\nYour answer should include:\n- Test types needed (unit, integration, e2e)\n- Key test cases with descriptions\n- Mocking strategy\n- Edge cases to cover`
    ),
    allowedActions: [
      'search_codebase',
      'recall_memory',
      'get_patterns',
      'search_similar',
      'find_symbol',
      'search_docs',
    ],
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
  return Object.values(agentProfiles).map((p) => ({
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
    description:
      'Search the codebase for relevant source code by semantic similarity. Returns matching code snippets with file paths and relevance scores.',
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
    description:
      'Recall memories from past sessions — decisions, bugs, context, insights. Useful for understanding prior work and avoiding repeated mistakes.',
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
    description:
      'Get architectural patterns and coding conventions used in the project. Useful for ensuring consistency.',
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
    description:
      'Get Architecture Decision Records (ADRs) — past decisions about design, technology choices, and trade-offs.',
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
    description:
      'Find code similar to a given snippet. Useful for finding duplicates, related implementations, or patterns.',
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

  hybrid_search: {
    name: 'hybrid_search',
    description:
      'Search the codebase using hybrid dense+sparse vectors for better recall. Combines semantic similarity with keyword matching.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query describing what to find',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: ['query'],
    },
  },

  search_docs: {
    name: 'search_docs',
    description: 'Search project documentation (markdown, README, etc.) by semantic similarity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in documentation',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 3)',
        },
      },
      required: ['query'],
    },
  },

  search_graph: {
    name: 'search_graph',
    description:
      'Explore file dependency graph — find imports, dependents, and blast radius of a file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to expand dependencies for',
        },
        file: {
          type: 'string',
          description: 'Single file path (alternative to files array)',
        },
        hops: {
          type: 'number',
          description: 'Number of hops to traverse (default: 1)',
        },
      },
      required: [],
    },
  },

  find_symbol: {
    name: 'find_symbol',
    description:
      'Fast lookup of function, class, or type definitions by name. Returns file path and line number.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Symbol name to find (function, class, type, etc.)',
        },
        kind: {
          type: 'string',
          description: 'Filter by symbol kind: function, class, interface, type, enum',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: ['name'],
    },
  },

  remember: {
    name: 'remember',
    description:
      'Save a memory (insight, decision, pattern) for future recall. Persists across sessions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'Memory content to save',
        },
        type: {
          type: 'string',
          description: 'Memory type: note, decision, insight, context',
          enum: ['note', 'decision', 'insight', 'context'],
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
      },
      required: ['content'],
    },
  },

  list_memories: {
    name: 'list_memories',
    description: 'List stored memories for the project, optionally filtered by type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Filter by memory type: all, note, decision, insight, context',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
      },
      required: [],
    },
  },

  explain_code: {
    name: 'explain_code',
    description:
      'Explain code in the context of the project. Finds relevant code and provides a clear explanation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'What to explain — a function name, concept, or code snippet',
        },
      },
      required: ['query'],
    },
  },
};

/**
 * Get Claude tool definitions for a given set of allowed actions.
 */
export function getToolDefinitions(allowedActions: string[]): Anthropic.Tool[] {
  return allowedActions
    .filter((action) => TOOL_DEFINITIONS[action])
    .map((action) => TOOL_DEFINITIONS[action]);
}
