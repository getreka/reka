import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/llm', () => ({
  llm: {
    completeWithBestProvider: vi.fn(),
  },
}));

import { llm } from '../../services/llm';
import { relationshipClassifier } from '../../services/relationship-classifier';

const mockedLLM = vi.mocked(llm);

describe('RelationshipClassifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies relationships using LLM response', async () => {
    mockedLLM.completeWithBestProvider.mockResolvedValue({
      text: JSON.stringify([
        { id: 'mem-1', type: 'supersedes', reason: 'More complete version', confidence: 0.9 },
        { id: 'mem-2', type: 'none', reason: 'Unrelated', confidence: 0.3 },
      ]),
    });

    const result = await relationshipClassifier.classify(
      { content: 'Use Redis for caching', type: 'decision' },
      [
        { id: 'mem-1', content: 'Use Memcached for caching', type: 'decision' },
        { id: 'mem-2', content: 'Deploy on Kubernetes', type: 'insight' },
      ]
    );

    // mem-1 should be classified, mem-2 filtered (type=none)
    expect(result).toHaveLength(1);
    expect(result[0].targetId).toBe('mem-1');
    expect(result[0].type).toBe('supersedes');
    expect(result[0].confidence).toBe(0.9);
  });

  it('filters out low-confidence results', async () => {
    mockedLLM.completeWithBestProvider.mockResolvedValue({
      text: JSON.stringify([{ id: 'mem-1', type: 'relates_to', reason: 'Maybe', confidence: 0.3 }]),
    });

    const result = await relationshipClassifier.classify({ content: 'test', type: 'note' }, [
      { id: 'mem-1', content: 'other', type: 'note' },
    ]);

    expect(result).toHaveLength(0); // confidence < 0.5
  });

  it('filters out invalid relationship types', async () => {
    mockedLLM.completeWithBestProvider.mockResolvedValue({
      text: JSON.stringify([
        { id: 'mem-1', type: 'INVALID_TYPE', reason: 'test', confidence: 0.8 },
      ]),
    });

    const result = await relationshipClassifier.classify({ content: 'test', type: 'note' }, [
      { id: 'mem-1', content: 'other', type: 'note' },
    ]);

    expect(result).toHaveLength(0);
  });

  it('filters out IDs not in candidates', async () => {
    mockedLLM.completeWithBestProvider.mockResolvedValue({
      text: JSON.stringify([
        { id: 'UNKNOWN-ID', type: 'supersedes', reason: 'test', confidence: 0.9 },
      ]),
    });

    const result = await relationshipClassifier.classify({ content: 'test', type: 'note' }, [
      { id: 'mem-1', content: 'other', type: 'note' },
    ]);

    expect(result).toHaveLength(0);
  });

  it('returns empty on LLM failure', async () => {
    mockedLLM.completeWithBestProvider.mockRejectedValue(new Error('timeout'));

    const result = await relationshipClassifier.classify({ content: 'test', type: 'note' }, [
      { id: 'mem-1', content: 'other', type: 'note' },
    ]);

    expect(result).toHaveLength(0);
  });

  it('handles malformed JSON response', async () => {
    mockedLLM.completeWithBestProvider.mockResolvedValue({
      text: 'This is not JSON at all',
    });

    const result = await relationshipClassifier.classify({ content: 'test', type: 'note' }, [
      { id: 'mem-1', content: 'other', type: 'note' },
    ]);

    expect(result).toHaveLength(0);
  });

  it('returns empty for empty candidates', async () => {
    const result = await relationshipClassifier.classify({ content: 'test', type: 'note' }, []);

    expect(result).toHaveLength(0);
    expect(mockedLLM.completeWithBestProvider).not.toHaveBeenCalled();
  });

  it('uses utility complexity and JSON format', async () => {
    mockedLLM.completeWithBestProvider.mockResolvedValue({ text: '[]' });

    await relationshipClassifier.classify({ content: 'test', type: 'note' }, [
      { id: 'mem-1', content: 'other', type: 'note' },
    ]);

    expect(mockedLLM.completeWithBestProvider).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        complexity: 'utility',
        format: 'json',
        think: false,
      })
    );
  });
});
