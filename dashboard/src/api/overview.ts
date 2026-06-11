import client from "./client";
import type {
  ToolStats,
  KnowledgeGap,
  Session,
  PlatformStats,
  DeveloperProfile,
  CacheStats,
} from "@/types/api";

export async function fetchToolAnalytics(days = 7): Promise<ToolStats> {
  const { data } = await client.get("/api/tool-analytics", {
    params: { days },
  });
  return data;
}

export async function fetchKnowledgeGaps(limit = 20): Promise<KnowledgeGap[]> {
  const { data } = await client.get("/api/knowledge-gaps", {
    params: { limit },
  });
  return data.gaps ?? [];
}

export async function fetchSessions(limit = 5): Promise<Session[]> {
  const { data } = await client.get("/api/sessions", { params: { limit } });
  return data.sessions ?? [];
}

export async function fetchPlatformStats(): Promise<PlatformStats> {
  const { data } = await client.get("/api/platform/stats");
  return data;
}

export async function fetchDeveloperProfile(): Promise<DeveloperProfile> {
  const { data } = await client.get("/api/developer-profile");
  return data;
}

export async function fetchCacheAnalytics(): Promise<CacheStats> {
  const { data } = await client.get("/api/cache/analytics");
  return data;
}
