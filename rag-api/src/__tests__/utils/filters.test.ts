import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSearchFilter, SearchFilters } from '../../utils/filters';

describe('buildSearchFilter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns undefined when input is undefined', () => {
    expect(buildSearchFilter(undefined)).toBeUndefined();
  });

  it('returns undefined when input is an empty object (no conditions)', () => {
    expect(buildSearchFilter({})).toBeUndefined();
  });

  it('returns must array with 1 condition for language filter', () => {
    const result = buildSearchFilter({ language: 'typescript' });

    expect(result).toEqual({
      must: [{ key: 'language', match: { value: 'typescript' } }],
    });
  });

  it('uses text match (not value) for path filter', () => {
    const result = buildSearchFilter({ path: 'src/services' });

    expect(result).toEqual({
      must: [{ key: 'file', match: { text: 'src/services' } }],
    });
  });

  it('returns must array with 1 condition for layer filter', () => {
    const result = buildSearchFilter({ layer: 'service' });

    expect(result).toEqual({
      must: [{ key: 'layer', match: { value: 'service' } }],
    });
  });

  it('returns must array with 1 condition for service filter', () => {
    const result = buildSearchFilter({ service: 'UserService' });

    expect(result).toEqual({
      must: [{ key: 'service', match: { value: 'UserService' } }],
    });
  });

  it('combines all 4 filters into must array with 4 conditions', () => {
    const filters: SearchFilters = {
      language: 'typescript',
      path: 'src/services',
      layer: 'service',
      service: 'UserService',
    };

    const result = buildSearchFilter(filters);

    expect(result).toEqual({
      must: [
        { key: 'language', match: { value: 'typescript' } },
        { key: 'file', match: { text: 'src/services' } },
        { key: 'layer', match: { value: 'service' } },
        { key: 'service', match: { value: 'UserService' } },
      ],
    });
    expect((result as any).must).toHaveLength(4);
  });

  it('handles language filter alone with correct key name', () => {
    const result = buildSearchFilter({ language: 'python' });
    const must = (result as any).must;

    expect(must[0].key).toBe('language');
    expect(must[0].match.value).toBe('python');
  });

  it('handles path filter with text match key', () => {
    const result = buildSearchFilter({ path: 'components/ui' });
    const must = (result as any).must;

    expect(must[0].key).toBe('file');
    expect(must[0].match.text).toBe('components/ui');
    expect(must[0].match.value).toBeUndefined();
  });

  it('handles two filters → must array with 2 conditions', () => {
    const result = buildSearchFilter({ language: 'typescript', layer: 'api' });

    expect((result as any).must).toHaveLength(2);
  });
});
