import client from "./client";

export interface DebateSummary {
  id: string;
  topic: string;
  positions: string[];
  status: string;
  verdict?: any;
  createdAt: string;
  durationMs?: number;
}

export interface DebateDetail {
  id: string;
  topic: string;
  positions: string[];
  phases: any[];
  verdict: any;
  scores: any;
  createdAt: string;
}

export async function fetchDebateHistory(limit = 20): Promise<DebateSummary[]> {
  const { data } = await client.get("/api/tribunal/history", {
    params: { limit },
  });
  return data.debates ?? [];
}

export async function fetchDebateDetail(id: string): Promise<DebateDetail> {
  const { data } = await client.get(`/api/tribunal/debate/${id}`);
  return data.debate ?? data;
}
