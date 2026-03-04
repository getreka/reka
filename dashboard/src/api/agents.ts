import client from './client'

export interface AgentTypeInfo {
  type: string
  description: string
  tools?: string[]
}

export interface AgentTypesResponse {
  agents: AgentTypeInfo[]
  autonomous: AgentTypeInfo[]
}

export interface RunReactAgentOpts {
  agentType: string
  task: string
  context?: string
  maxIterations?: number
  timeout?: number
  includeThinking?: boolean
}

export interface RunAutonomousAgentOpts {
  projectPath: string
  type: string
  task: string
  maxTurns?: number
  maxBudgetUsd?: number
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
}

export interface AgentStep {
  thought?: string
  action?: string
  observation?: string
  thinking?: string
}

export interface AgentResult {
  status: string
  result?: string
  error?: string
  steps?: AgentStep[]
  iterations?: number
  totalTokens?: number
  cost?: number
  duration?: number
  agentId?: string
  model?: string
  turns?: number
  budgetUsed?: number
}

export async function fetchAgentTypes(): Promise<AgentTypesResponse> {
  const { data } = await client.get('/api/agent/types')
  return data
}

export async function runReactAgent(opts: RunReactAgentOpts): Promise<AgentResult> {
  const { data } = await client.post('/api/agent/run', opts, { timeout: 300000 })
  return data
}

export async function runAutonomousAgent(opts: RunAutonomousAgentOpts): Promise<AgentResult> {
  const { data } = await client.post('/api/agent/autonomous', opts, { timeout: 300000 })
  return data
}

export async function stopAutonomousAgent(agentId: string): Promise<{ stopped: boolean; agentId: string }> {
  const { data } = await client.post('/api/agent/autonomous/stop', { agentId })
  return data
}

export async function fetchRunningAgents(): Promise<{ running: string[]; count: number }> {
  const { data } = await client.get('/api/agent/autonomous/running')
  return data
}
