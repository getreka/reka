import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockEmbedding } from '../helpers/fixtures';

const mockQdrantClient = vi.hoisted(() => ({
  scroll: vi.fn(),
}));

vi.mock('../../services/vector-store', () => ({
  vectorStore: {
    upsert: vi.fn(),
    search: vi.fn(),
    deleteByFilter: vi.fn(),
    client: mockQdrantClient,
  },
  default: {
    upsert: vi.fn(),
    search: vi.fn(),
    deleteByFilter: vi.fn(),
    client: mockQdrantClient,
  },
}));

vi.mock('../../services/embedding', () => ({
  embeddingService: {
    embed: vi.fn(),
    embedBatch: vi.fn(),
  },
  default: {
    embed: vi.fn(),
    embedBatch: vi.fn(),
  },
}));

import { vectorStore } from '../../services/vector-store';
import { embeddingService } from '../../services/embedding';
import { symbolIndex } from '../../services/symbol-index';

const mockedVS = vi.mocked(vectorStore);
const mockedEmbed = vi.mocked(embeddingService);

describe('SymbolIndexService', () => {
  const fakeVector = mockEmbedding(1024);

  beforeEach(() => {
    vi.resetAllMocks();
    mockedEmbed.embed.mockResolvedValue(fakeVector);
    mockedEmbed.embedBatch.mockResolvedValue([fakeVector, fakeVector]);
    mockedVS.upsert.mockResolvedValue(undefined);
    mockedVS.deleteByFilter.mockResolvedValue(undefined);
  });

  describe('indexFileSymbols', () => {
    it('batch-embeds symbols and upserts points to {project}_symbols', async () => {
      const content = `
        export function myFunction(x: number): string { return String(x); }
        export class MyClass {}
      `;

      const count = await symbolIndex.indexFileSymbols(
        'testproj',
        'src/utils.ts',
        content,
        ['myFunction', 'MyClass'],
        1,
        20
      );

      expect(count).toBe(2);

      expect(mockedEmbed.embedBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.stringContaining('myFunction'),
          expect.stringContaining('MyClass'),
        ])
      );

      expect(mockedVS.upsert).toHaveBeenCalledWith(
        'testproj_symbols',
        expect.arrayContaining([
          expect.objectContaining({
            vector: fakeVector,
            payload: expect.objectContaining({
              name: 'myFunction',
              file: 'src/utils.ts',
              startLine: 1,
              endLine: 20,
              project: 'testproj',
            }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              name: 'MyClass',
            }),
          }),
        ])
      );
    });

    it('returns 0 and skips upsert when symbols array is empty', async () => {
      const count = await symbolIndex.indexFileSymbols(
        'testproj', 'src/empty.ts', 'const x = 1;', [], 1, 1
      );

      expect(count).toBe(0);
      expect(mockedEmbed.embedBatch).not.toHaveBeenCalled();
      expect(mockedVS.upsert).not.toHaveBeenCalled();
    });

    it('infers kind correctly from content', async () => {
      mockedEmbed.embedBatch.mockResolvedValue([fakeVector]);

      const content = 'export interface MyInterface { name: string; }';

      await symbolIndex.indexFileSymbols(
        'proj', 'src/types.ts', content, ['MyInterface'], 1, 5
      );

      const upsertCall = mockedVS.upsert.mock.calls[0];
      const point = upsertCall[1][0];
      expect(point.payload.kind).toBe('interface');
    });

    it('sets exports:true when content includes export and symbol name', async () => {
      mockedEmbed.embedBatch.mockResolvedValue([fakeVector]);

      const content = 'export const myConst = 42;';

      await symbolIndex.indexFileSymbols(
        'proj', 'src/consts.ts', content, ['myConst'], 1, 1
      );

      const point = mockedVS.upsert.mock.calls[0][1][0];
      expect(point.payload.exports).toBe(true);
    });

    it('stores indexedAt timestamp in payload', async () => {
      mockedEmbed.embedBatch.mockResolvedValue([fakeVector]);

      await symbolIndex.indexFileSymbols(
        'proj', 'src/x.ts', 'export function foo() {}', ['foo'], 1, 3
      );

      const point = mockedVS.upsert.mock.calls[0][1][0];
      expect(point.payload.indexedAt).toBeDefined();
      expect(typeof point.payload.indexedAt).toBe('string');
    });
  });

  describe('findSymbol', () => {
    it('searches {project}_symbols with embedded query and returns matching symbols', async () => {
      mockedVS.search.mockResolvedValue([
        {
          id: 's-1',
          score: 0.95,
          payload: {
            name: 'AuthService',
            kind: 'class',
            file: 'src/auth.ts',
            startLine: 10,
            endLine: 50,
            signature: 'export class AuthService',
            exports: true,
          },
        },
      ]);

      const results = await symbolIndex.findSymbol('testproj', 'AuthService');

      expect(mockedEmbed.embed).toHaveBeenCalledWith(expect.stringContaining('AuthService'));
      expect(mockedVS.search).toHaveBeenCalledWith(
        'testproj_symbols',
        fakeVector,
        10,
        undefined,
        0.5
      );

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('AuthService');
      expect(results[0].kind).toBe('class');
      expect(results[0].file).toBe('src/auth.ts');
      expect(results[0].startLine).toBe(10);
      expect(results[0].exports).toBe(true);
    });

    it('passes kind filter to vectorStore.search when kind is provided', async () => {
      mockedVS.search.mockResolvedValue([]);

      await symbolIndex.findSymbol('testproj', 'processData', 'function', 5);

      expect(mockedVS.search).toHaveBeenCalledWith(
        'testproj_symbols',
        fakeVector,
        5,
        { must: [{ key: 'kind', match: { value: 'function' } }] },
        0.5
      );
    });

    it('returns empty array when collection does not exist (404)', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockedVS.search.mockRejectedValue(err);

      const results = await symbolIndex.findSymbol('testproj', 'missing');

      expect(results).toEqual([]);
    });

    it('returns empty array on search error', async () => {
      mockedVS.search.mockRejectedValue(new Error('Qdrant error'));

      const results = await symbolIndex.findSymbol('testproj', 'anything');

      expect(results).toEqual([]);
    });

    it('includes no kind filter when kind is not provided', async () => {
      mockedVS.search.mockResolvedValue([]);

      await symbolIndex.findSymbol('testproj', 'SomeSymbol');

      const searchCall = mockedVS.search.mock.calls[0];
      expect(searchCall[3]).toBeUndefined();
    });
  });

  describe('getFileExports', () => {
    it('scrolls {project}_symbols with file + exports:true filter', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [
          {
            id: 's-1',
            payload: {
              name: 'exportedFn',
              kind: 'function',
              file: 'src/utils.ts',
              startLine: 5,
              endLine: 15,
              signature: 'export function exportedFn()',
              exports: true,
            },
          },
        ],
        next_page_offset: undefined,
      });

      const exports = await symbolIndex.getFileExports('testproj', 'src/utils.ts');

      expect(mockQdrantClient.scroll).toHaveBeenCalledWith(
        'testproj_symbols',
        expect.objectContaining({
          filter: {
            must: [
              { key: 'file', match: { value: 'src/utils.ts' } },
              { key: 'exports', match: { value: true } },
            ],
          },
        })
      );

      expect(exports).toHaveLength(1);
      expect(exports[0].name).toBe('exportedFn');
      expect(exports[0].kind).toBe('function');
      expect(exports[0].exports).toBe(true);
    });

    it('returns empty array when no exports found', async () => {
      mockQdrantClient.scroll.mockResolvedValue({
        points: [],
        next_page_offset: undefined,
      });

      const exports = await symbolIndex.getFileExports('testproj', 'src/internal.ts');

      expect(exports).toEqual([]);
    });

    it('returns empty array when collection does not exist (404)', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockQdrantClient.scroll.mockRejectedValue(err);

      const exports = await symbolIndex.getFileExports('testproj', 'src/any.ts');

      expect(exports).toEqual([]);
    });
  });

  describe('clearFileSymbols', () => {
    it('calls deleteByFilter with file filter on {project}_symbols', async () => {
      await symbolIndex.clearFileSymbols('testproj', 'src/old.ts');

      expect(mockedVS.deleteByFilter).toHaveBeenCalledWith(
        'testproj_symbols',
        { must: [{ key: 'file', match: { value: 'src/old.ts' } }] }
      );
    });

    it('ignores 404 errors silently', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockedVS.deleteByFilter.mockRejectedValue(err);

      await expect(
        symbolIndex.clearFileSymbols('testproj', 'src/gone.ts')
      ).resolves.toBeUndefined();
    });
  });
});
