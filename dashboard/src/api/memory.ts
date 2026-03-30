import client from "./client";
import type {
  Memory,
  MemoryType,
  MemoryStats,
  QuarantineMemory,
  MergeCluster,
  LTMMemory,
  StaleMemory,
  LTMStats,
} from "@/types/memory";

export async function fetchMemoryList(params: {
  type?: MemoryType | "all";
  tag?: string;
  limit?: number;
  offset?: number;
}): Promise<{ memories: Memory[]; total: number }> {
  const { data } = await client.get("/api/memory/list", { params });
  return {
    memories: data.memories ?? [],
    total: data.total ?? data.memories?.length ?? 0,
  };
}

export async function fetchMemoryStats(): Promise<MemoryStats> {
  const { data } = await client.get("/api/memory/stats");
  return data.stats;
}

export async function fetchQuarantine(limit = 20): Promise<QuarantineMemory[]> {
  const { data } = await client.get("/api/memory/quarantine", {
    params: { limit },
  });
  return data.memories ?? [];
}

export async function fetchUnvalidated(
  limit = 20,
): Promise<QuarantineMemory[]> {
  const { data } = await client.get("/api/memory/unvalidated", {
    params: { limit },
  });
  return data.memories ?? [];
}

export async function recallMemories(
  query: string,
  type?: string,
  limit = 10,
): Promise<Memory[]> {
  const { data } = await client.post("/api/memory/recall", {
    query,
    type,
    limit,
  });
  return data.results ?? [];
}

export async function deleteMemory(id: string): Promise<boolean> {
  const { data } = await client.delete(`/api/memory/${id}`);
  return data.success;
}

export async function validateMemory(
  id: string,
  validated: boolean,
): Promise<void> {
  await client.patch(`/api/memory/${id}/validate`, { validated });
}

export async function promoteMemory(
  memoryId: string,
  reason: string,
): Promise<void> {
  await client.post("/api/memory/promote", { memoryId, reason });
}

export async function createMemoryApi(params: {
  type: MemoryType;
  content: string;
  relatedTo?: string;
  tags: string[];
}): Promise<void> {
  await client.post("/api/memory", params);
}

export async function mergeMemoriesApi(
  dryRun: boolean,
): Promise<MergeCluster[]> {
  const { data } = await client.post("/api/memory/merge", { dryRun });
  return data.clusters ?? [];
}

export async function bulkDeleteByTypeApi(type: MemoryType): Promise<void> {
  await client.delete(`/api/memory/type/${type}`);
}

export async function fetchEpisodicMemories(limit = 50): Promise<LTMMemory[]> {
  const { data } = await client.get("/api/memory/episodic", {
    params: { limit },
  });
  return data.memories ?? [];
}

export async function fetchSemanticMemories(limit = 50): Promise<LTMMemory[]> {
  const { data } = await client.get("/api/memory/semantic", {
    params: { limit },
  });
  return data.memories ?? [];
}

export async function fetchStaleMemories(): Promise<StaleMemory[]> {
  const { data } = await client.get("/api/memory/stale");
  return data.staleMemories ?? [];
}

export async function fetchLTMStats(): Promise<LTMStats | null> {
  const { data } = await client.get("/api/memory/ltm-stats");
  return data ?? null;
}
