export interface HealthResponse {
  status: string;
  uptime: number;
  version?: string;
}

export interface ToolStats {
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  topTools: { tool: string; count: number; avgMs: number }[];
  callsByHour: Record<string, number>;
  errorRate: number;
}

export interface KnowledgeGap {
  query: string;
  toolName: string;
  resultCount: number;
  timestamp: string;
}

export interface QualityMetrics {
  search: {
    totalFeedback: number;
    helpfulRate: number;
    avgResultCount: number;
  };
  memory: {
    totalFeedback: number;
    accurateRate: number;
    outdatedRate: number;
  };
}

export interface Session {
  id: string;
  projectName: string;
  status: "active" | "ended";
  initialContext?: string;
  startedAt: string;
  endedAt?: string;
  currentFiles: string[];
  recentQueries: string[];
  toolsUsed: string[];
  activeFeatures: string[];
}

export interface PredictionStats {
  totalPredictions: number;
  hitRate: number;
  strategies: Record<string, number>;
}

export interface PlatformStats {
  totalProjects: number;
  totalCollections: number;
  projects: {
    project: string;
    collections: number;
    totalVectors: number;
  }[];
}

export interface DeveloperProfile {
  frequentFiles: { file: string; count: number }[];
  preferredTools: string[];
  peakHours: Record<string, number>;
  commonPatterns: string[];
}

export interface CacheStats {
  enabled?: boolean;
  connected?: boolean;
  totalKeys?: number;
  embeddingKeys?: number;
  searchKeys?: number;
  sessionKeys?: number;
  memoryUsage?: string;
  // Alternative shape from some endpoints
  hitRate?: number;
  totalRequests?: number;
  totalHits?: number;
  memoryUsageMb?: number;
}

export interface FeedbackStats {
  totalFeedback: number;
  helpfulRate: number;
  searchFeedback: number;
  memoryFeedback: number;
}
