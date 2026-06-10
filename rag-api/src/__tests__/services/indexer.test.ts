import { describe, it, expect } from 'vitest';

// Only test pure exported functions — avoid mocking heavy dependencies
import {
  getCollectionName,
  getIndexStatus,
  filterValidDensePoints,
  filterValidSparsePoints,
} from '../../services/indexer';
import { mockEmbedding } from '../helpers/fixtures';

describe('Indexer — pure exports', () => {
  describe('getCollectionName()', () => {
    it('returns codebase collection by default', () => {
      expect(getCollectionName('myproject')).toBe('myproject_codebase');
    });

    it('returns codebase collection when type is codebase', () => {
      expect(getCollectionName('myproject', 'codebase')).toBe('myproject_codebase');
    });

    it('returns docs collection when type is docs', () => {
      expect(getCollectionName('myproject', 'docs')).toBe('myproject_docs');
    });

    it('handles project names with hyphens', () => {
      expect(getCollectionName('my-project')).toBe('my-project_codebase');
    });
  });

  describe('getIndexStatus()', () => {
    it('returns idle status for unknown project', () => {
      const status = getIndexStatus('unknown-project-xyz');
      expect(status.status).toBe('idle');
      expect(status.totalFiles).toBe(0);
      expect(status.processedFiles).toBe(0);
    });
  });

  describe('filterValidDensePoints()', () => {
    it('keeps points whose vector matches VECTOR_SIZE', () => {
      const points = [
        { vector: mockEmbedding(1024), payload: { id: 'a' } },
        { vector: mockEmbedding(1024), payload: { id: 'b' } },
      ];
      const { valid, skipped } = filterValidDensePoints(points, 'test');
      expect(valid).toHaveLength(2);
      expect(skipped).toBe(0);
    });

    it('drops empty and short vectors but keeps valid ones', () => {
      const points = [
        { vector: mockEmbedding(1024), payload: { id: 'good' } },
        { vector: [], payload: { id: 'empty' } },
        { vector: mockEmbedding(512), payload: { id: 'short' } },
        { vector: mockEmbedding(1024), payload: { id: 'good2' } },
      ];
      const { valid, skipped } = filterValidDensePoints(points, 'test');
      expect(valid).toHaveLength(2);
      expect(skipped).toBe(2);
      expect((valid[0].payload as any).id).toBe('good');
      expect((valid[1].payload as any).id).toBe('good2');
    });
  });

  describe('filterValidSparsePoints()', () => {
    it('drops sparse points with empty dense vectors', () => {
      const points = [
        {
          vectors: { dense: mockEmbedding(1024), sparse: { indices: [1], values: [0.5] } },
          payload: { id: 'good' },
        },
        {
          vectors: { dense: [], sparse: { indices: [1], values: [0.5] } },
          payload: { id: 'bad' },
        },
      ];
      const { valid, skipped } = filterValidSparsePoints(points, 'test');
      expect(valid).toHaveLength(1);
      expect(skipped).toBe(1);
    });
  });
});
