import { describe, it, expect } from 'vitest';
import {
  agentProfiles,
  getAgentProfile,
  listAgentTypes,
  getToolDefinitions,
  AgentProfile,
} from '../../services/agent-profiles';

describe('agentProfiles', () => {
  const expectedTypes = ['research', 'review', 'documentation', 'refactor', 'test'];

  it('defines exactly 5 agent profiles', () => {
    expect(Object.keys(agentProfiles)).toHaveLength(5);
  });

  it.each(expectedTypes)('profile "%s" has all required fields', (type) => {
    const profile = agentProfiles[type];
    expect(profile).toBeDefined();
    expect(profile.name).toBe(type);
    expect(typeof profile.description).toBe('string');
    expect(profile.description.length).toBeGreaterThan(10);
    expect(typeof profile.systemPrompt).toBe('string');
    expect(Array.isArray(profile.allowedActions)).toBe(true);
    expect(profile.allowedActions.length).toBeGreaterThan(0);
    expect(['markdown', 'json']).toContain(profile.outputFormat);
    expect(profile.maxIterations).toBeGreaterThan(0);
    expect(profile.timeout).toBeGreaterThan(0);
    expect(profile.temperature).toBeGreaterThanOrEqual(0);
    expect(profile.temperature).toBeLessThanOrEqual(1);
  });

  it.each(expectedTypes)('profile "%s" systemPrompt includes ReAct format instructions', (type) => {
    const profile = agentProfiles[type];
    expect(profile.systemPrompt).toContain('THOUGHT');
    expect(profile.systemPrompt).toContain('ACTION');
    expect(profile.systemPrompt).toContain('FINAL_ANSWER');
  });

  it('research profile has highest maxIterations', () => {
    expect(agentProfiles.research.maxIterations).toBe(10);
  });

  it('review profile has lowest temperature', () => {
    expect(agentProfiles.review.temperature).toBe(0.2);
  });
});

describe('getAgentProfile()', () => {
  it('returns profile for valid type', () => {
    const profile = getAgentProfile('research');
    expect(profile).toBeDefined();
    expect(profile!.name).toBe('research');
  });

  it('returns undefined for unknown type', () => {
    expect(getAgentProfile('nonexistent')).toBeUndefined();
  });
});

describe('listAgentTypes()', () => {
  it('returns 5 entries with name and description', () => {
    const types = listAgentTypes();
    expect(types).toHaveLength(5);

    for (const entry of types) {
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('description');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.description).toBe('string');
    }
  });

  it('includes all expected type names', () => {
    const names = listAgentTypes().map((t) => t.name);
    expect(names).toContain('research');
    expect(names).toContain('review');
    expect(names).toContain('documentation');
    expect(names).toContain('refactor');
    expect(names).toContain('test');
  });
});

describe('getToolDefinitions()', () => {
  it('returns tool definitions for known actions', () => {
    const tools = getToolDefinitions(['search_codebase', 'recall_memory']);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('search_codebase');
    expect(tools[1].name).toBe('recall_memory');
  });

  it('filters out unknown actions', () => {
    const tools = getToolDefinitions(['search_codebase', 'nonexistent']);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('search_codebase');
  });

  it('returns empty array for empty input', () => {
    expect(getToolDefinitions([])).toHaveLength(0);
  });

  it('each tool has required schema fields', () => {
    const allActions = [
      'search_codebase',
      'recall_memory',
      'get_patterns',
      'get_adrs',
      'search_similar',
    ];
    const tools = getToolDefinitions(allActions);
    expect(tools).toHaveLength(5);

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    }
  });
});
