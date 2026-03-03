import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  ingest: vi.fn(),
}));

vi.mock('../../services/llm', () => ({ llm: { complete: mocks.complete } }));
vi.mock('../../services/memory', () => ({ memoryService: {}, MemoryType: {} }));
vi.mock('../../services/memory-governance', () => ({
  memoryGovernance: { ingest: mocks.ingest },
}));
vi.mock('ts-morph', () => ({
  Project: vi.fn().mockImplementation(() => ({
    createSourceFile: vi.fn().mockReturnValue({
      getFunctions: vi.fn().mockReturnValue([]),
      getClasses: vi.fn().mockReturnValue([]),
      getInterfaces: vi.fn().mockReturnValue([]),
      getTypeAliases: vi.fn().mockReturnValue([]),
      getEnums: vi.fn().mockReturnValue([]),
      getVariableDeclarations: vi.fn().mockReturnValue([]),
      delete: vi.fn(),
    }),
  })),
}));

import { conversationAnalyzer } from '../../services/conversation-analyzer';

describe('ConversationAnalyzerService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('analyze', () => {
    it('returns parsed learnings, entities, and summary', async () => {
      const analysis = {
        learnings: [
          { type: 'insight', content: 'Redis caching improves latency', tags: ['cache'], confidence: 0.9, reasoning: 'confirmed' },
        ],
        entities: { files: ['cache.ts'], functions: ['getCache'], concepts: ['Redis'] },
        summary: 'Discussed caching strategy',
      };
      mocks.complete.mockResolvedValue({ text: JSON.stringify(analysis) });

      const result = await conversationAnalyzer.analyze({
        projectName: 'test',
        conversation: 'User discussed caching with Redis',
      });

      expect(result.learnings).toHaveLength(1);
      expect(result.entities.files).toContain('cache.ts');
      expect(result.summary).toBe('Discussed caching strategy');
    });

    it('filters learnings by minConfidence', async () => {
      const analysis = {
        learnings: [
          { type: 'insight', content: 'high', tags: [], confidence: 0.9, reasoning: '' },
          { type: 'note', content: 'low', tags: [], confidence: 0.3, reasoning: '' },
        ],
        entities: { files: [], functions: [], concepts: [] },
        summary: 'test',
      };
      mocks.complete.mockResolvedValue({ text: JSON.stringify(analysis) });

      const result = await conversationAnalyzer.analyze({
        projectName: 'test',
        conversation: 'test',
        minConfidence: 0.5,
      });

      expect(result.learnings).toHaveLength(1);
      expect(result.learnings[0].content).toBe('high');
    });

    it('with autoSave calls saveLearnings', async () => {
      const analysis = {
        learnings: [
          { type: 'insight', content: 'save me', tags: ['test'], confidence: 0.8, reasoning: 'valid' },
        ],
        entities: { files: [], functions: [], concepts: [] },
        summary: 'test',
      };
      mocks.complete.mockResolvedValue({ text: JSON.stringify(analysis) });
      mocks.ingest.mockResolvedValue({ id: 'mem-1' });

      const result = await conversationAnalyzer.analyze({
        projectName: 'test',
        conversation: 'test',
        autoSave: true,
      });

      expect(result.learnings).toHaveLength(1);
      expect(mocks.ingest).toHaveBeenCalled();
    });

    it('handles non-JSON LLM response with defaults', async () => {
      mocks.complete.mockResolvedValue({ text: 'not valid json at all' });

      const result = await conversationAnalyzer.analyze({
        projectName: 'test',
        conversation: 'test',
      });

      expect(result.learnings).toEqual([]);
      expect(result.entities).toEqual({ files: [], functions: [], concepts: [] });
    });
  });

  describe('saveLearnings', () => {
    it('calls governance ingest for each learning', async () => {
      mocks.ingest
        .mockResolvedValueOnce({ id: 'mem-1' })
        .mockResolvedValueOnce({ id: 'mem-2' });

      const ids = await conversationAnalyzer.saveLearnings('test', [
        { type: 'insight' as any, content: 'first', tags: [], confidence: 0.8, reasoning: '' },
        { type: 'decision' as any, content: 'second', tags: [], confidence: 0.9, reasoning: '' },
      ]);

      expect(ids).toHaveLength(2);
      expect(mocks.ingest).toHaveBeenCalledTimes(2);
    });

    it('handles individual save failures gracefully', async () => {
      mocks.ingest
        .mockResolvedValueOnce({ id: 'mem-1' })
        .mockRejectedValueOnce(new Error('failed'));

      const ids = await conversationAnalyzer.saveLearnings('test', [
        { type: 'insight' as any, content: 'works', tags: [], confidence: 0.8, reasoning: '' },
        { type: 'insight' as any, content: 'fails', tags: [], confidence: 0.8, reasoning: '' },
      ]);

      expect(ids).toHaveLength(1);
    });
  });

  describe('extractEntities', () => {
    it('extracts file paths from text', async () => {
      const result = await conversationAnalyzer.extractEntities(
        'Check the file src/services/auth.ts and also settings.yaml for config'
      );

      expect(result.files).toContain('src/services/auth.ts');
      expect(result.files).toContain('settings.yaml');
    });

    it('extracts function names and PascalCase concepts', async () => {
      const result = await conversationAnalyzer.extractEntities(
        'The function handleAuth and class AuthService are important. Also check MiddlewareStack.'
      );

      expect(result.functions).toContain('handleAuth');
      expect(result.concepts).toContain('AuthService');
      expect(result.concepts).toContain('MiddlewareStack');
    });
  });
});
