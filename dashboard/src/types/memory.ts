export type MemoryType =
  | "decision"
  | "insight"
  | "context"
  | "todo"
  | "conversation"
  | "note";

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  tags: string[];
  relatedTo?: string;
  score?: number;
  createdAt: string;
  validated?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
}

export interface QuarantineMemory {
  id: string;
  content: string;
  type: MemoryType;
  tags: string[];
  confidence?: number;
  source?: string;
  createdAt: string;
}

export interface MergeCluster {
  count: number;
  items: { id: string; content: string }[];
}

export interface LTMMemory {
  id: string;
  content: string;
  type: string;
  tags: string[];
  score?: number;
  createdAt: string;
  lastAccessed?: string;
  metadata?: Record<string, unknown>;
}

export interface StaleMemory {
  id: string;
  content: string;
  reason: string;
  lastAccessed?: string;
  score?: number;
  type?: string;
  tags?: string[];
  createdAt?: string;
}

export interface LTMStats {
  episodic: { count: number; avgAge: number };
  semantic: { count: number; avgAge: number };
  pending: { count: number };
}
