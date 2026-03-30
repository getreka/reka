import client from "./client";
import type { SearchResult, SearchMode } from "@/types/search";

function getDefaultCollection(): string {
  const project =
    localStorage.getItem("rag_project") ||
    import.meta.env.VITE_DEFAULT_PROJECT ||
    "rag";
  return `${project}_code`;
}

function getProjectName(): string {
  return (
    localStorage.getItem("rag_project") ||
    import.meta.env.VITE_DEFAULT_PROJECT ||
    "rag"
  );
}

function normalizeResults(data: any): SearchResult[] {
  const results: SearchResult[] = [];
  const items = data.results || data.files || data.matches || data.groups || [];

  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item === "string") {
      results.push({ id: item, file: item, score: 0, content: "" });
      continue;
    }
    results.push({
      id: item.id || item.file || results.length,
      file: item.file || item.filePath || item.path || "",
      score: item.score ?? item.similarity ?? 0,
      content: item.content || item.text || item.snippet || "",
      language: item.language,
      layer: item.layer,
      chunkType: item.chunkType || item.type,
      line: item.line,
    });
  }
  return results;
}

export async function searchHybrid(
  query: string,
  options: {
    limit?: number;
    language?: string;
    layer?: string;
    semanticWeight?: number;
  } = {},
): Promise<{ results: SearchResult[]; meta?: any }> {
  const { data } = await client.post("/api/search-hybrid", {
    collection: getDefaultCollection(),
    query,
    limit: options.limit || 20,
    semanticWeight: options.semanticWeight ?? 0.7,
    filters: {
      language: options.language || undefined,
      layer: options.layer || undefined,
    },
  });
  return { results: normalizeResults(data), meta: data.meta };
}

export async function searchSemantic(
  query: string,
  options: {
    limit?: number;
    language?: string;
    layer?: string;
  } = {},
): Promise<{ results: SearchResult[] }> {
  const { data } = await client.post("/api/search", {
    collection: getDefaultCollection(),
    query,
    limit: options.limit || 20,
    filters: {
      language: options.language || undefined,
      layer: options.layer || undefined,
    },
  });
  return { results: normalizeResults(data) };
}

export async function searchSymbol(
  symbol: string,
  options: {
    kind?: string;
    limit?: number;
  } = {},
): Promise<{ results: SearchResult[] }> {
  const { data } = await client.post("/api/find-symbol", {
    projectName: getProjectName(),
    symbol,
    kind: options.kind,
    limit: options.limit || 20,
  });
  const results: SearchResult[] = (data.symbols || data.results || []).map(
    (s: any) => ({
      id: s.id || `${s.file}:${s.name}`,
      file: s.file || s.filePath || "",
      score: s.score ?? 1,
      content: s.signature || s.name || "",
      language: s.language,
      layer: s.layer,
      chunkType: s.kind || "symbol",
      line: s.line,
    }),
  );
  return { results };
}

export async function searchGraph(
  query: string,
  options: {
    limit?: number;
    expandHops?: number;
  } = {},
): Promise<{ results: SearchResult[] }> {
  const { data } = await client.post("/api/search-graph", {
    collection: getDefaultCollection(),
    query,
    limit: options.limit || 10,
    expandHops: options.expandHops ?? 1,
  });
  return { results: normalizeResults(data) };
}
