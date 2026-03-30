export interface SessionListItem {
  id?: string;
  sessionId?: string;
  projectName: string;
  status: "active" | "ended";
  initialContext?: string;
  startedAt: string;
  endedAt?: string;
  duration?: number;
}

export interface SessionDetail {
  id?: string;
  sessionId?: string;
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

export interface SensoryEvent {
  id?: string;
  type: string;
  tool?: string;
  content?: string;
  query?: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface SensoryStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  oldestEvent?: string;
  newestEvent?: string;
}

export interface WorkingMemorySlot {
  id?: string;
  index?: number;
  type: string;
  content: string;
  salience: number;
  timestamp?: string;
  metadata?: Record<string, any>;
}

export interface WorkingMemoryState {
  slots: WorkingMemorySlot[];
  capacity: number;
}
