export interface GraphNode {
  id: string;
  name: string;
  category?: number;
  type?: string;
  connectionCount?: number;
}

export type ConfidenceLevel = "scip" | "tree-sitter" | "heuristic";
export type ConfidenceFilter = "all" | "scip" | "tree-sitter+" | "any";

export interface GraphLink {
  source: string;
  target: string;
  type?: string;
  confidence?: ConfidenceLevel;
  symbolDescriptor?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface BlastRadiusResult {
  affectedFiles: { file: string; hop: number }[];
  totalAffected: number;
}

export type LayoutMode = "force" | "circular" | "tree";
export type EdgeTypeFilter =
  | "all"
  | "imports"
  | "extends"
  | "implements"
  | "calls"
  | "depends_on";

export interface FileExport {
  name: string;
  kind: string;
  line?: number;
}

export interface NodeInspectorData {
  file: string;
  exports: FileExport[];
  dependencies: string[];
  dependents: string[];
}
