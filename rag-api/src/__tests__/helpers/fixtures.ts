/**
 * Test fixtures — mock data factories for unit tests.
 */

import { v4 as uuidv4 } from 'uuid';

/** Generate a fake embedding vector of the given dimension. */
export function mockEmbedding(dim = 1024): number[] {
  return Array.from({ length: dim }, () => Math.random() * 2 - 1);
}

/** Generate a Qdrant-style search result with sensible defaults. */
export function mockSearchResult(
  overrides?: Partial<{
    id: string;
    score: number;
    payload: Record<string, unknown>;
  }>
): { id: string; score: number; payload: Record<string, unknown> } {
  return {
    id: overrides?.id ?? uuidv4(),
    score: overrides?.score ?? 0.85,
    payload: {
      file: 'src/services/example.ts',
      content: 'export class ExampleService {}',
      language: 'typescript',
      type: 'code',
      ...overrides?.payload,
    },
  };
}

/** Generate a Memory-shaped object. */
export function mockMemory(
  overrides?: Partial<{
    id: string;
    type: string;
    content: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    metadata: Record<string, unknown>;
    validated: boolean;
    supersededBy: string;
    source: string;
    confidence: number;
  }>
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: overrides?.id ?? uuidv4(),
    type: overrides?.type ?? 'note',
    content: overrides?.content ?? 'Test memory content',
    tags: overrides?.tags ?? ['test'],
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
    metadata: overrides?.metadata,
    validated: overrides?.validated,
    supersededBy: overrides?.supersededBy,
    source: overrides?.source,
    confidence: overrides?.confidence,
  };
}

/** Generate a VectorPoint-compatible object. */
export function mockVectorPoint(
  overrides?: Partial<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>
): { id: string; vector: number[]; payload: Record<string, unknown> } {
  return {
    id: overrides?.id ?? uuidv4(),
    vector: overrides?.vector ?? mockEmbedding(),
    payload: overrides?.payload ?? {
      file: 'src/test.ts',
      content: 'test content',
    },
  };
}
