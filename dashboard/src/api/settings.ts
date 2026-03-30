import client from "./client";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsed?: string;
}

export interface ApiKeyCreated {
  id: string;
  name: string;
  key: string;
  createdAt: string;
}

export interface UsageDay {
  date: string;
  requests: number;
}

export interface UsageStats {
  totalRequests: number;
  totalTokens: number;
  costEstimate: number;
  byDay: UsageDay[];
}

export interface QueueInfo {
  name: string;
  concurrency: number;
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
}

export interface ActorInfo {
  name: string;
  concurrency: number;
  status?: string;
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const { data } = await client.get("/api/keys");
  return data.keys ?? [];
}

export async function createApiKey(name: string): Promise<ApiKeyCreated> {
  const { data } = await client.post("/api/keys", { name });
  return data.key;
}

export async function deleteApiKey(id: string): Promise<void> {
  await client.delete(`/api/keys/${id}`);
}

export async function fetchUsage(): Promise<UsageStats> {
  const { data } = await client.get("/api/billing/usage");
  return data;
}

export async function fetchQueues(): Promise<QueueInfo[]> {
  const { data } = await client.get("/api/admin/queues");
  return data.queues ?? [];
}

export async function fetchActors(): Promise<ActorInfo[]> {
  const { data } = await client.get("/api/admin/actors");
  return data.actors ?? [];
}
