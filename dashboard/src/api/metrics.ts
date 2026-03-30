import client from "./client";

export async function fetchPrometheusMetrics(): Promise<string> {
  const { data } = await client.get("/metrics", { responseType: "text" });
  return data;
}

export async function fetchQueues(): Promise<
  Record<
    string,
    { waiting: number; active: number; completed: number; failed: number }
  >
> {
  const { data } = await client.get("/api/admin/queues");
  return data;
}

export async function fetchActors(): Promise<
  Record<
    string,
    { mailboxDepth: number; active: number; completed: number; failed: number }
  >
> {
  const { data } = await client.get("/api/admin/actors");
  return data;
}
