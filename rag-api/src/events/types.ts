// All events follow {domain}:{action} pattern
// Every payload includes projectName, timestamp, correlationId

export type MemoryEventType =
  | 'memory:created'
  | 'memory:recalled'
  | 'memory:deleted'
  | 'memory:superseded'
  | 'memory:promoted'
  | 'memory:merged';
export type SessionEventType =
  | 'session:started'
  | 'session:activity'
  | 'session:ending'
  | 'session:ended';
export type IndexEventType =
  | 'index:started'
  | 'index:progress'
  | 'index:completed'
  | 'index:failed';
export type ConsolidationEventType =
  | 'consolidation:started'
  | 'consolidation:completed'
  | 'consolidation:failed';
export type MaintenanceEventType =
  | 'maintenance:cycle.started'
  | 'maintenance:cycle.completed'
  | 'maintenance:dedup.completed'
  | 'maintenance:governance.completed';
export type SensoryEventType = 'sensory:appended';

export type DomainEventType =
  | MemoryEventType
  | SessionEventType
  | IndexEventType
  | ConsolidationEventType
  | MaintenanceEventType
  | SensoryEventType;

export interface BaseEventPayload {
  projectName: string;
  timestamp: string;
  correlationId: string;
}

// Memory payloads
export interface MemoryCreatedPayload extends BaseEventPayload {
  memoryId: string;
  type: string;
  content: string;
  tags: string[];
  embedding: number[]; // pass embedding so worker doesn't re-embed
}

export interface RecalledMemoryItem {
  id: string;
  content: string;
  type?: string;
  tags?: string[];
  collection?: 'episodic' | 'semantic' | 'durable';
}

export interface MemoryRecalledPayload extends BaseEventPayload {
  query: string;
  resultCount: number;
  memoryIds: string[];
  recalledMemories: RecalledMemoryItem[];
}

// Session payloads
export interface SessionStartedPayload extends BaseEventPayload {
  sessionId: string;
  resumedFrom?: string;
  initialContext?: string;
}

export interface SessionEndingPayload extends BaseEventPayload {
  sessionId: string;
  summary?: string;
}

// Index payloads
export interface IndexProgressPayload extends BaseEventPayload {
  processedFiles: number;
  totalFiles: number;
}

// Generic payload map for type-safe dispatch
export interface EventPayloadMap {
  'memory:created': MemoryCreatedPayload;
  'memory:recalled': MemoryRecalledPayload;
  'memory:deleted': BaseEventPayload & { memoryId: string };
  'memory:superseded': BaseEventPayload & { memoryId: string; supersededById: string };
  'memory:promoted': BaseEventPayload & { memoryId: string };
  'memory:merged': BaseEventPayload & { clusterSize: number; mergedMemoryId: string };
  'session:started': SessionStartedPayload;
  'session:activity': BaseEventPayload & { sessionId: string; activityType: string };
  'session:ending': SessionEndingPayload;
  'session:ended': BaseEventPayload & {
    sessionId: string;
    duration: number;
    learningsSaved: number;
  };
  'index:started': BaseEventPayload & { totalFiles: number };
  'index:progress': IndexProgressPayload;
  'index:completed': BaseEventPayload & { stats: Record<string, unknown> };
  'index:failed': BaseEventPayload & { error: string };
  'consolidation:started': BaseEventPayload & { sessionId: string };
  'consolidation:completed': BaseEventPayload & {
    sessionId: string;
    episodicCount: number;
    semanticCount: number;
  };
  'consolidation:failed': BaseEventPayload & { sessionId: string; error: string };
  'maintenance:cycle.started': BaseEventPayload;
  'maintenance:cycle.completed': BaseEventPayload & {
    projectsProcessed: number;
    totalMerged: number;
    totalDeleted: number;
    totalExpired: number;
  };
  'maintenance:dedup.completed': BaseEventPayload & { merged: number; deleted: number };
  'maintenance:governance.completed': BaseEventPayload & { expired: number };
  'sensory:appended': BaseEventPayload & { sessionId: string; eventType: string; value: unknown };
}

// Helper to generate correlation IDs
export function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
