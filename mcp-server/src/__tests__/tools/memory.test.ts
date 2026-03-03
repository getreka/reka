import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryTools } from '../../tools/memory';
import type { ToolContext } from '../../types';

function createMockCtx(): ToolContext {
  return {
    api: {
      post: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
      defaults: { baseURL: 'http://localhost:3100' },
    } as any,
    projectName: 'testproject',
    projectPath: '/tmp/testproject',
    collectionPrefix: 'testproject',
    enrichmentEnabled: false,
  };
}

describe('Memory Tools', () => {
  let tools: ReturnType<typeof createMemoryTools>;
  let ctx: ToolContext;

  beforeEach(() => {
    vi.resetAllMocks();
    tools = createMemoryTools('testproject');
    ctx = createMockCtx();
  });

  function findTool(name: string) {
    return tools.find(t => t.name === name)!;
  }

  describe('remember', () => {
    it('stores memory and returns formatted result', async () => {
      const mem = { id: 'mem-1', type: 'note', content: 'test note', createdAt: new Date().toISOString() };
      (ctx.api.post as any).mockResolvedValue({ data: { memory: mem } });

      const result = await findTool('remember').handler(
        { content: 'test note', type: 'note', tags: ['tag1'] },
        ctx
      );

      expect(ctx.api.post).toHaveBeenCalledWith('/api/memory', expect.objectContaining({
        projectName: 'testproject',
        content: 'test note',
        type: 'note',
      }));
      expect(result).toContain('Memory stored');
      expect(result).toContain('mem-1');
    });
  });

  describe('recall', () => {
    it('returns formatted results', async () => {
      (ctx.api.post as any).mockResolvedValue({
        data: {
          results: [
            { memory: { type: 'insight', content: 'found it', createdAt: new Date().toISOString(), tags: [] }, score: 0.85 },
          ],
        },
      });

      const result = await findTool('recall').handler(
        { query: 'find something', limit: 5 },
        ctx
      );

      expect(result).toContain('Recalled Memories');
    });

    it('returns empty message when no results', async () => {
      (ctx.api.post as any).mockResolvedValue({ data: { results: [] } });

      const result = await findTool('recall').handler({ query: 'nothing' }, ctx);
      expect(result).toContain('No memories found');
    });
  });

  describe('forget', () => {
    it('deletes by memoryId', async () => {
      (ctx.api.delete as any).mockResolvedValue({ data: { success: true } });

      const result = await findTool('forget').handler({ memoryId: 'mem-1' }, ctx);

      expect(ctx.api.delete).toHaveBeenCalledWith(
        expect.stringContaining('/api/memory/mem-1')
      );
      expect(result).toContain('deleted');
    });

    it('deletes by type', async () => {
      (ctx.api.delete as any).mockResolvedValue({ data: {} });

      const result = await findTool('forget').handler({ type: 'note' }, ctx);

      expect(ctx.api.delete).toHaveBeenCalledWith(
        expect.stringContaining('/api/memory/type/note')
      );
      expect(result).toContain('note');
    });

    it('deletes by olderThanDays', async () => {
      (ctx.api.post as any).mockResolvedValue({ data: { deleted: 10 } });

      const result = await findTool('forget').handler({ olderThanDays: 30 }, ctx);

      expect(ctx.api.post).toHaveBeenCalledWith('/api/memory/forget-older', expect.objectContaining({
        olderThanDays: 30,
      }));
      expect(result).toContain('10');
    });

    it('returns message when nothing specified', async () => {
      const result = await findTool('forget').handler({}, ctx);
      expect(result).toContain('specify');
    });
  });

  describe('promote_memory', () => {
    it('promotes and returns formatted result', async () => {
      const mem = { id: 'mem-1', type: 'insight', content: 'promoted' };
      (ctx.api.post as any).mockResolvedValue({ data: { memory: mem } });

      const result = await findTool('promote_memory').handler(
        { memoryId: 'mem-1', reason: 'human_validated' },
        ctx
      );

      expect(result).toContain('promoted to durable');
      expect(result).toContain('mem-1');
    });
  });

  describe('memory_maintenance', () => {
    it('formats maintenance results', async () => {
      (ctx.api.post as any).mockResolvedValue({
        data: {
          quarantine_cleanup: { rejected: ['q-1', 'q-2'], errors: [] },
          feedback_maintenance: { promoted: ['f-1'], pruned: [], errors: [] },
        },
      });

      const result = await findTool('memory_maintenance').handler({}, ctx);

      expect(result).toContain('Maintenance Results');
      expect(result).toContain('Quarantine Cleanup');
      expect(result).toContain('Feedback Maintenance');
    });
  });

  describe('batch_remember', () => {
    it('stores multiple memories', async () => {
      (ctx.api.post as any).mockResolvedValue({
        data: {
          savedCount: 2,
          memories: [
            { id: 'b-1', type: 'note', content: 'first' },
            { id: 'b-2', type: 'insight', content: 'second' },
          ],
          errors: [],
        },
      });

      const result = await findTool('batch_remember').handler(
        { items: [{ content: 'first' }, { content: 'second', type: 'insight' }] },
        ctx
      );

      expect(result).toContain('Saved');
      expect(result).toContain('2');
    });
  });
});
