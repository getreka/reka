import client from "./client";

export interface VectorPoint {
  id: string | number;
  payload: Record<string, unknown>;
  vector?: number[];
}

export async function scrollVectors(
  collection: string,
  limit = 200,
  offset?: string,
  withVectors = true,
): Promise<{ points: VectorPoint[]; nextOffset?: string | number }> {
  const { data } = await client.get(`/api/collections/${collection}/scroll`, {
    params: { limit, offset, vectors: withVectors },
    timeout: 30000,
  });
  return data;
}
