import client from "./client";
import type {
  SessionListItem,
  SessionDetail,
  SensoryEvent,
  SensoryStats,
  WorkingMemoryState,
} from "@/types/session";

export async function fetchSessionsList(params: {
  limit?: number;
  status?: "all" | "active" | "ended";
}): Promise<SessionListItem[]> {
  const { data } = await client.get("/api/sessions", { params });
  return data.sessions ?? [];
}

export async function fetchSessionDetail(
  sessionId: string,
): Promise<SessionDetail> {
  const { data } = await client.get(`/api/session/${sessionId}`);
  return data.session ?? data;
}

export async function startSession(
  initialContext?: string,
): Promise<SessionDetail> {
  const { data } = await client.post("/api/session/start", { initialContext });
  return data.session ?? data;
}

export async function endSession(
  sessionId: string,
  summary?: string,
): Promise<void> {
  await client.post(`/api/session/${sessionId}/end`, { summary });
}

export async function fetchSensoryEvents(
  sessionId: string,
): Promise<SensoryEvent[]> {
  try {
    const { data } = await client.get(`/api/sensory/${sessionId}`);
    return data.events ?? [];
  } catch {
    return [];
  }
}

export async function fetchSensoryStats(
  sessionId: string,
): Promise<SensoryStats | null> {
  try {
    const { data } = await client.get(`/api/sensory/${sessionId}/stats`);
    return data;
  } catch {
    return null;
  }
}

export async function fetchWorkingMemory(
  sessionId: string,
): Promise<WorkingMemoryState | null> {
  try {
    const { data } = await client.get(`/api/working-memory/${sessionId}`);
    return { slots: data.slots ?? [], capacity: data.capacity ?? 0 };
  } catch {
    return null;
  }
}

export async function fetchSessionActivity(sessionId: string): Promise<any[]> {
  try {
    const events = await fetchSensoryEvents(sessionId);
    if (events.length > 0) return events;
    const { data } = await client.get(`/api/session/${sessionId}`);
    const session = data.session ?? data;
    return (
      session.toolCalls ||
      session.activity ||
      session.recentQueries?.map((q: string, i: number) => ({
        id: `q-${i}`,
        type: "query",
        tool: "search",
        query: q,
        timestamp: session.startedAt,
      })) ||
      []
    );
  } catch {
    return [];
  }
}
