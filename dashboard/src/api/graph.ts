import client from "./client";
import type {
  GraphNode,
  GraphLink,
  BlastRadiusResult,
  NodeInspectorData,
} from "@/types/graph";

function normalizeEdges(data: any): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const seen = new Set<string>();
  const connectionCount = new Map<string, number>();

  // Collect raw edges from various API response formats
  let rawEdges: Array<{
    source: string;
    target: string;
    type?: string;
    confidence?: string;
    symbolDescriptor?: string;
  }> = [];

  if (data.edges) {
    rawEdges = data.edges.map((e: any) => ({
      source: e.source || e.fromFile,
      target: e.target || e.toFile,
      type: e.type || e.edgeType || "imports",
      confidence: e.confidence,
      symbolDescriptor: e.symbolDescriptor,
    }));
  } else if (data.dependencies) {
    // Format: { file, dependencies: [{ fromFile, toFile, edgeType }] }
    rawEdges = data.dependencies.map((d: any) => ({
      source: d.fromFile || d.source || data.file,
      target: d.toFile || d.target,
      type: d.edgeType || d.type || "imports",
      confidence: d.confidence,
      symbolDescriptor: d.symbolDescriptor,
    }));
  } else if (data.dependents) {
    rawEdges = data.dependents.map((d: any) => ({
      source: d.fromFile || d.source,
      target: d.toFile || d.target || data.file,
      type: d.edgeType || d.type || "imports",
      confidence: d.confidence,
      symbolDescriptor: d.symbolDescriptor,
    }));
  } else if (data.nodes) {
    return { nodes: data.nodes, links: data.links ?? [] };
  }

  // Deduplicate edges by unique source/target/type triple
  const edgeSet = new Set<string>();
  const uniqueEdges: typeof rawEdges = [];
  for (const edge of rawEdges) {
    if (!edge.source || !edge.target) continue;
    const key = `${edge.source}->${edge.target}:${edge.type || "imports"}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      uniqueEdges.push(edge);
    }
  }

  // Count connections
  for (const edge of uniqueEdges) {
    connectionCount.set(
      edge.source,
      (connectionCount.get(edge.source) || 0) + 1,
    );
    connectionCount.set(
      edge.target,
      (connectionCount.get(edge.target) || 0) + 1,
    );
  }

  // Build nodes and links
  for (const edge of uniqueEdges) {
    if (!seen.has(edge.source)) {
      nodes.push({
        id: edge.source,
        name: edge.source.split("/").pop() || edge.source,
        type: "file",
        connectionCount: connectionCount.get(edge.source) || 1,
      });
      seen.add(edge.source);
    }
    if (!seen.has(edge.target)) {
      nodes.push({
        id: edge.target,
        name: edge.target.split("/").pop() || edge.target,
        type: "file",
        connectionCount: connectionCount.get(edge.target) || 1,
      });
      seen.add(edge.target);
    }
    links.push({
      source: edge.source,
      target: edge.target,
      type: edge.type || "imports",
      ...(edge.confidence !== undefined && {
        confidence: edge.confidence as import("@/types/graph").ConfidenceLevel,
      }),
      ...(edge.symbolDescriptor !== undefined && {
        symbolDescriptor: edge.symbolDescriptor,
      }),
    });
  }

  return { nodes, links };
}

export async function fetchDependencies(
  file: string,
  depth = 1,
): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
  const { data } = await client.get("/api/graph/dependencies", {
    params: { file, depth },
  });
  return normalizeEdges(data);
}

export async function fetchDependents(
  file: string,
  depth = 1,
): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
  const { data } = await client.get("/api/graph/dependents", {
    params: { file, depth },
  });
  return normalizeEdges(data);
}

export async function fetchBlastRadius(
  file: string,
  maxDepth = 3,
): Promise<BlastRadiusResult> {
  const { data } = await client.post("/api/graph/blast-radius", {
    files: [file],
    maxDepth,
  });
  return {
    affectedFiles: data.affectedFiles ?? [],
    totalAffected: data.totalAffected ?? data.affectedFiles?.length ?? 0,
  };
}

export async function fetchFileExports(
  file: string,
): Promise<NodeInspectorData> {
  try {
    const { data } = await client.post("/api/file-exports", { file });
    return {
      file,
      exports: data.exports ?? [],
      dependencies: data.dependencies ?? [],
      dependents: data.dependents ?? [],
    };
  } catch {
    // Fallback: use graph endpoints to get deps/dependents
    try {
      const [depsRes, revRes] = await Promise.all([
        client.get("/api/graph/dependencies", { params: { file, depth: 1 } }),
        client.get("/api/graph/dependents", { params: { file, depth: 1 } }),
      ]);
      const deps = (depsRes.data.dependencies || [])
        .map((d: any) => d.toFile)
        .filter(Boolean);
      const revDeps = (revRes.data.dependents || [])
        .map((d: any) => d.fromFile)
        .filter(Boolean);
      return { file, exports: [], dependencies: deps, dependents: revDeps };
    } catch {
      return { file, exports: [], dependencies: [], dependents: [] };
    }
  }
}
