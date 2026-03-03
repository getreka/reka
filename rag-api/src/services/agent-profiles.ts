/**
 * Agent Profiles - Specialized agent configurations for the ReAct runtime.
 *
 * Each profile defines a system prompt, allowed actions, and limits
 * for a specific type of autonomous agent.
 */

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

export const agentProfiles: Record<string, AgentProfile> = {
  research: {
    name: 'research',
    description: 'Investigates the codebase, finds patterns, and synthesizes analysis. Best for understanding how things work.',
    systemPrompt: `${REACT_FORMAT_INSTRUCTIONS}

You are a Research Agent. Thoroughly investigate the codebase to answer questions.

Your answer should include:
- Key findings with file references
- Relevant patterns or conventions discovered
- Connections between different parts of the codebase`,
    allowedActions: ['search_codebase', 'recall_memory', 'get_patterns', 'get_adrs', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: 10,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  review: {
    name: 'review',
    description: 'Reviews code against project patterns, ADRs, and best practices. Identifies issues and improvements.',
    systemPrompt: `${REACT_FORMAT_INSTRUCTIONS}

You are a Code Review Agent. Review code against project standards and conventions.

Your answer should include:
- Pattern compliance assessment
- Specific issues found (with severity)
- Suggested improvements
- Positive aspects of the code`,
    allowedActions: ['recall_memory', 'get_patterns', 'get_adrs', 'search_codebase', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: 6,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.2,
  },

  documentation: {
    name: 'documentation',
    description: 'Analyzes code and generates documentation. Understands context through codebase exploration.',
    systemPrompt: `${REACT_FORMAT_INSTRUCTIONS}

You are a Documentation Agent. Analyze code and produce clear documentation.

Your answer should include:
- Overview of what the code does
- Key interfaces/types explained
- Usage examples where applicable
- Dependencies and relationships`,
    allowedActions: ['search_codebase', 'recall_memory', 'get_patterns', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: 6,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  refactor: {
    name: 'refactor',
    description: 'Finds code smells and suggests refactoring based on project patterns and best practices.',
    systemPrompt: `${REACT_FORMAT_INSTRUCTIONS}

You are a Refactoring Agent. Identify code smells and suggest improvements.

Your answer should include:
- Code smells identified (with locations)
- Recommended refactoring approach
- Expected benefits
- Risk assessment`,
    allowedActions: ['search_codebase', 'recall_memory', 'get_patterns', 'get_adrs', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: 8,
    timeout: config.AGENT_TIMEOUT,
    temperature: 0.3,
  },

  test: {
    name: 'test',
    description: 'Generates test strategies based on codebase patterns. Identifies what and how to test.',
    systemPrompt: `${REACT_FORMAT_INSTRUCTIONS}

You are a Testing Agent. Create test strategies based on project patterns.

Your answer should include:
- Test types needed (unit, integration, e2e)
- Key test cases with descriptions
- Mocking strategy
- Edge cases to cover`,
    allowedActions: ['search_codebase', 'recall_memory', 'get_patterns', 'search_similar'],
    outputFormat: 'markdown',
    maxIterations: 6,
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
