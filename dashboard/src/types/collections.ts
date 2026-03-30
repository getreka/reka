export interface CollectionSummary {
  name: string;
  vectorsCount: number;
  status: string;
}

export type VectorParams = { size?: number; distance?: string };
export type VectorsConfig = Record<string, VectorParams> | VectorParams;

export interface CollectionInfo {
  name: string;
  vectorsCount: number;
  status: string;
  config?: {
    params?: {
      vectors?: VectorsConfig;
    };
  };
  segments?: number;
  indexedFields?: string[];
  optimizerStatus?: string;
  pointsCount?: number;
}

export interface IndexStatus {
  status: "idle" | "indexing" | "completed" | "error";
  progress?: number;
  indexedFiles?: number;
  totalFiles?: number;
  errors?: string[];
  vectorCount?: number;
  collectionStatus?: string;
}

export interface AliasInfo {
  aliasName: string;
  collectionName: string;
}

export interface Snapshot {
  name: string;
  creationTime: string;
  size: number;
}

export interface CollectionAnalytics {
  vectors: number;
  segments: number;
  diskUsageMb?: number;
  languageBreakdown?: Record<string, number>;
}

export interface ClusterHealth {
  status: string;
  nodes?: number;
  pendingOperations?: number;
}
