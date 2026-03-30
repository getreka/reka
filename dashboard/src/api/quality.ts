import client from "./client";
import type { DuplicateGroup, CodeCluster } from "@/types/quality";

function getDefaultCollection(): string {
  const project =
    localStorage.getItem("rag_project") ||
    import.meta.env.VITE_DEFAULT_PROJECT ||
    "rag";
  return `${project}_code`;
}

export async function fetchDuplicates(
  threshold = 0.9,
  limit = 50,
): Promise<DuplicateGroup[]> {
  const collection = getDefaultCollection();
  const { data } = await client.post("/api/duplicates", {
    collection,
    threshold,
    limit,
  });
  const groups: DuplicateGroup[] = [];
  const items = data.duplicates || data.groups || [];
  for (let i = 0; i < items.length; i++) {
    const g = items[i];
    groups.push({
      id: `dup-${i}`,
      files: (g.files || g.points || []).map((f: any) => ({
        file: typeof f === "string" ? f : f.file || f.path || f.id || "",
        content: f.content || f.snippet || "",
      })),
      similarity: g.similarity ?? g.score ?? 0,
      snippet: g.files?.[0]?.content?.slice(0, 100) || "",
    });
  }
  return groups;
}

export async function fetchClusters(
  seedIds?: string[],
  limit = 20,
): Promise<CodeCluster[]> {
  const collection = getDefaultCollection();

  // If no seedIds provided, first scroll some points to use as seeds
  let ids = seedIds;
  if (!ids || ids.length === 0) {
    try {
      const { data: scrollData } = await client.get(
        `/api/collections/${collection}/scroll`,
        {
          params: { limit: 5, vectors: false },
        },
      );
      ids = (scrollData.points || []).map((p: any) => String(p.id)).slice(0, 5);
    } catch {
      return [];
    }
  }

  if (!ids || ids.length === 0) return [];

  const { data } = await client.post("/api/clusters", {
    collection,
    seedIds: ids,
    limit,
  });
  const clusters: CodeCluster[] = [];
  const items = data.clusters || [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const files = (c.points || c.files || []).map((p: any) =>
      typeof p === "string" ? p : p.payload?.file || p.file || String(p.id),
    );
    clusters.push({
      id: `cluster-${i}`,
      label: c.label || `Cluster ${i + 1}`,
      files,
      similarity: c.similarity ?? c.score ?? 0,
    });
  }
  return clusters;
}
