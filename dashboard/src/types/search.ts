export type SearchMode = "hybrid" | "semantic" | "symbol" | "graph";

export interface SearchResult {
  id: string | number;
  file: string;
  score: number;
  content: string;
  language?: string;
  layer?: string;
  chunkType?: string;
  line?: number;
  highlights?: string[];
}

export interface SearchMeta {
  mode: SearchMode;
  query: string;
  rewrittenQuery?: string;
  timing?: number;
  totalResults: number;
}
