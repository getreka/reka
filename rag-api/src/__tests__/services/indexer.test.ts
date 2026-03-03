import { describe, it, expect } from 'vitest';

// Only test pure exported functions — avoid mocking heavy dependencies
import { getCollectionName, getIndexStatus } from '../../services/indexer';

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
});
