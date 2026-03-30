import client from "./client";

export interface QueueStats {
  name: string;
  active: number;
  completed: number;
  delayed: number;
  failed: number;
  paused: number;
  waiting: number;
}

export interface DLQJob {
  id: string;
  queue: string;
  name: string;
  data: any;
  failedReason: string;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
}

export interface ActorStatus {
  actorType: string;
  mailboxDepth: number;
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
}

export async function fetchQueues(): Promise<QueueStats[]> {
  const { data } = await client.get("/api/admin/queues");
  return data.queues ?? [];
}

export async function fetchDLQ(
  limit = 20,
): Promise<{ totalFailed: number; jobs: DLQJob[] }> {
  const { data } = await client.get("/api/admin/dlq", { params: { limit } });
  return data;
}

export async function retryDLQJob(queue: string, jobId: string) {
  const { data } = await client.post(`/api/admin/dlq/${queue}/${jobId}/retry`);
  return data;
}

export async function deleteDLQJob(queue: string, jobId: string) {
  const { data } = await client.delete(`/api/admin/dlq/${queue}/${jobId}`);
  return data;
}

export async function fetchActors(): Promise<ActorStatus[]> {
  const { data } = await client.get("/api/admin/actors");
  return data.actors ?? [];
}
