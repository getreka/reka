import client from "./client";
import type {
  CollectionSummary,
  CollectionInfo,
  IndexStatus,
  AliasInfo,
  Snapshot,
  CollectionAnalytics,
  ClusterHealth,
} from "@/types/collections";

export async function fetchCollections(
  project?: string,
): Promise<CollectionSummary[]> {
  const { data } = await client.get("/api/collections", {
    params: project ? { project } : {},
  });
  return data.collections ?? [];
}

export async function fetchCollectionInfo(
  name: string,
): Promise<CollectionInfo> {
  const { data } = await client.get(`/api/collections/${name}/info`);
  return data;
}

export async function fetchIndexStatus(
  collection: string,
): Promise<IndexStatus> {
  const { data } = await client.get(`/api/index/status/${collection}`);
  return data;
}

export async function fetchAliases(): Promise<AliasInfo[]> {
  const { data } = await client.get("/api/aliases");
  return data.aliases ?? [];
}

export async function triggerReindex(collection: string): Promise<void> {
  await client.post("/api/reindex", { collection });
}

export async function clearCollectionApi(name: string): Promise<void> {
  await client.post(`/api/collections/${name}/clear`);
}

export async function deleteCollectionApi(name: string): Promise<void> {
  await client.delete(`/api/collections/${name}`);
}

export async function createSnapshotApi(name: string): Promise<void> {
  await client.post(`/api/collections/${name}/snapshots`);
}

export async function listSnapshotsApi(name: string): Promise<Snapshot[]> {
  const { data } = await client.get(`/api/collections/${name}/snapshots`);
  return data.snapshots ?? [];
}

export async function fetchCollectionAnalytics(
  name: string,
): Promise<CollectionAnalytics> {
  const { data } = await client.get(`/api/analytics/${name}`);
  return data;
}

export async function fetchClusterHealth(): Promise<ClusterHealth> {
  const { data } = await client.get("/api/analytics/cluster/health");
  return data;
}
