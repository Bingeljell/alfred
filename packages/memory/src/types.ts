export type MemorySearchOptions = {
  maxResults?: number;
  minScore?: number;
};

export type MemoryResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

export type MemoryStatus = {
  indexedFileCount: number;
  chunkCount: number;
  lastSyncTime: string | null;
  dirty: boolean;
  provider: string;
  model: string;
  vectorEnabled: boolean;
};

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
