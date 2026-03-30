export interface DuplicateGroup {
  id: string;
  files: DuplicateFile[];
  similarity: number;
  snippet?: string;
}

export interface DuplicateFile {
  file: string;
  content?: string;
  lines?: { start: number; end: number };
}

export interface CodeCluster {
  id: string;
  label: string;
  files: string[];
  similarity: number;
}
