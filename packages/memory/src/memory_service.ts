import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chunkByApproxTokens } from "./chunker";
import { createDefaultEmbeddingProvider } from "./embeddings";
import { redactSecrets } from "./redact";
import { SqliteMemoryIndex, type IndexedChunk } from "./sqlite_memory_index";
import type { EmbeddingProvider, MemoryResult, MemorySearchOptions, MemoryStatus } from "./types";

type MemoryServiceOptions = {
  rootDir: string;
  stateDir: string;
  memoryDir?: string;
  includeFiles?: string[];
  embeddingProvider?: EmbeddingProvider | null;
  vectorWeight?: number;
  keywordWeight?: number;
  targetChunkTokens?: number;
  overlapChunkTokens?: number;
  syncIntervalMs?: number;
  watchDebounceMs?: number;
  enableWatch?: boolean;
};

function toIsoDate(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function fileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  return sha256(content);
}

export class MemoryService {
  private readonly rootDir: string;
  private readonly stateDir: string;
  private readonly memoryDir: string;
  private readonly includeFiles: string[];
  private readonly vectorWeight: number;
  private readonly keywordWeight: number;
  private readonly targetChunkTokens: number;
  private readonly overlapChunkTokens: number;
  private readonly syncIntervalMs: number;
  private readonly watchDebounceMs: number;
  private readonly enableWatch: boolean;
  private readonly index: SqliteMemoryIndex;
  private readonly embeddingProvider: EmbeddingProvider | null;

  private dirty = true;
  private lastSyncTime: string | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private watchDebounceTimer: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];

  constructor(options: MemoryServiceOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.stateDir = path.resolve(options.stateDir);
    this.memoryDir = path.resolve(options.memoryDir ?? path.join(this.rootDir, "memory"));
    this.includeFiles = options.includeFiles ?? ["MEMORY.md"];
    this.vectorWeight = options.vectorWeight ?? 0.7;
    this.keywordWeight = options.keywordWeight ?? 0.3;
    this.targetChunkTokens = options.targetChunkTokens ?? 500;
    this.overlapChunkTokens = options.overlapChunkTokens ?? 80;
    this.syncIntervalMs = options.syncIntervalMs ?? 60 * 60 * 1000;
    this.watchDebounceMs = options.watchDebounceMs ?? 1000;
    this.enableWatch = options.enableWatch ?? true;

    mkdirSync(this.stateDir, { recursive: true });
    const dbPath = path.join(this.stateDir, "memory_index.sqlite");
    this.index = new SqliteMemoryIndex(dbPath);
    this.embeddingProvider = options.embeddingProvider ?? createDefaultEmbeddingProvider(process.env);
  }

  async start(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.mkdir(this.memoryDir, { recursive: true });

    await this.syncMemory("startup");

    this.syncTimer = setInterval(() => {
      void this.syncMemory("interval");
    }, this.syncIntervalMs);

    if (this.enableWatch) {
      this.startWatchers();
    }
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.watchers = [];
    this.index.close();
  }

  async syncMemory(reason = "manual"): Promise<void> {
    const files = await this.discoverFiles();
    const discovered = new Set<string>();

    for (const absPath of files) {
      const relPath = this.toRepoRelative(absPath);
      discovered.add(relPath);

      const stat = await fs.stat(absPath);
      const hash = await fileHash(absPath);
      const existing = this.index.getFile(relPath);

      if (existing && existing.hash === hash && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
        continue;
      }

      const raw = await fs.readFile(absPath, "utf8");
      const chunks = chunkByApproxTokens(raw, {
        pathKey: relPath,
        targetTokens: this.targetChunkTokens,
        overlapTokens: this.overlapChunkTokens
      });

      const now = new Date().toISOString();
      const indexedChunks: IndexedChunk[] = [];

      for (const chunk of chunks) {
        const redacted = redactSecrets(chunk.text);
        const textHash = sha256(redacted);
        const embedding = await this.lookupOrCreateEmbedding(textHash, redacted);

        indexedChunks.push({
          id: chunk.id,
          path: relPath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: redacted,
          hash: textHash,
          embedding,
          updatedAt: now
        });
      }

      this.index.replaceChunksForFile(relPath, indexedChunks);
      this.index.upsertFile({
        path: relPath,
        hash,
        mtime: stat.mtimeMs,
        size: stat.size,
        updatedAt: now
      });
    }

    const existingFiles = this.index.listFiles();
    for (const file of existingFiles) {
      if (!discovered.has(file.path)) {
        this.index.deleteFile(file.path);
      }
    }

    this.dirty = false;
    this.lastSyncTime = new Date().toISOString();

    void reason;
  }

  async searchMemory(query: string, options: MemorySearchOptions = {}): Promise<MemoryResult[]> {
    if (this.dirty) {
      await this.syncMemory("search_dirty");
    }

    const maxResults = options.maxResults ?? 5;
    const minScore = options.minScore ?? 0.01;

    const keywordHits = this.index.queryKeyword(query, Math.max(maxResults * 4, 20));
    const combined = new Map<
      string,
      {
        path: string;
        startLine: number;
        endLine: number;
        snippet: string;
        keyword: number;
        vector: number;
      }
    >();

    for (const hit of keywordHits) {
      const keywordScore = 1 / (1 + Math.abs(hit.bm25));
      combined.set(hit.id, {
        path: hit.path,
        startLine: hit.startLine,
        endLine: hit.endLine,
        snippet: hit.text,
        keyword: keywordScore,
        vector: 0
      });
    }

    if (this.embeddingProvider) {
      try {
        const [queryEmbedding] = await this.embeddingProvider.embed([redactSecrets(query)]);
        const vectorCandidates = this.index.listVectorCandidates(Math.max(maxResults * 20, 200));

        for (const candidate of vectorCandidates) {
          const similarity = Math.max(0, cosineSimilarity(queryEmbedding, candidate.embedding));
          const existing = combined.get(candidate.id);
          if (existing) {
            existing.vector = Math.max(existing.vector, similarity);
            continue;
          }

          combined.set(candidate.id, {
            path: candidate.path,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            snippet: candidate.text,
            keyword: 0,
            vector: similarity
          });
        }
      } catch {
        // Embedding failure gracefully falls back to keyword-only ranking.
      }
    }

    const ranked = Array.from(combined.values())
      .map((entry) => {
        const score = entry.vector * this.vectorWeight + entry.keyword * this.keywordWeight;
        return {
          path: entry.path,
          startLine: entry.startLine,
          endLine: entry.endLine,
          score,
          snippet: entry.snippet,
          source: `${entry.path}:${entry.startLine}:${entry.endLine}`
        };
      })
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return ranked;
  }

  async getMemorySnippet(filePath: string, from = 1, lines = 20): Promise<string> {
    const absolute = this.resolveAllowedPath(filePath);
    const raw = await fs.readFile(absolute, "utf8");
    const all = raw.split(/\r?\n/);
    const start = Math.max(0, from - 1);
    const end = Math.min(all.length, start + lines);
    return all.slice(start, end).join("\n");
  }

  async appendMemoryNote(text: string, date = toIsoDate()): Promise<{ path: string }> {
    const target = path.join(this.memoryDir, `${date}.md`);
    await fs.mkdir(this.memoryDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const entry = `- [${timestamp}] [source=manual] ${text.trim()}\n`;
    await fs.appendFile(target, entry, "utf8");

    this.dirty = true;

    return {
      path: this.toRepoRelative(target)
    };
  }

  memoryStatus(): MemoryStatus {
    const provider = this.embeddingProvider?.provider ?? "none";
    const model = this.embeddingProvider?.model ?? "none";

    return {
      indexedFileCount: this.index.getFileCount(),
      chunkCount: this.index.getChunkCount(),
      lastSyncTime: this.lastSyncTime,
      dirty: this.dirty,
      provider,
      model,
      vectorEnabled: Boolean(this.embeddingProvider)
    };
  }

  markDirty(): void {
    this.dirty = true;
  }

  private async lookupOrCreateEmbedding(hash: string, text: string): Promise<number[] | null> {
    if (!this.embeddingProvider) {
      return null;
    }

    const cached = this.index.getCachedEmbedding(this.embeddingProvider.provider, this.embeddingProvider.model, hash);
    if (cached) {
      return cached;
    }

    try {
      const [embedding] = await this.embeddingProvider.embed([text]);
      this.index.setCachedEmbedding(this.embeddingProvider.provider, this.embeddingProvider.model, hash, embedding);
      return embedding;
    } catch {
      return null;
    }
  }

  private async discoverFiles(): Promise<string[]> {
    const files: string[] = [];

    const canonical = this.includeFiles.map((file) => path.resolve(this.rootDir, file));
    for (const file of canonical) {
      if (await this.existsAsRegularFile(file)) {
        files.push(file);
      }
    }

    files.push(...(await this.walkMarkdown(this.memoryDir)));

    return files;
  }

  private async walkMarkdown(dir: string): Promise<string[]> {
    if (!(await this.existsAsDirectory(dir))) {
      return [];
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        results.push(...(await this.walkMarkdown(full)));
        continue;
      }

      if (entry.isFile() && full.endsWith(".md")) {
        results.push(full);
      }
    }

    return results;
  }

  private async existsAsRegularFile(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(filePath);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private async existsAsDirectory(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private startWatchers(): void {
    try {
      const memoryWatcher = watch(this.memoryDir, { recursive: true }, () => {
        this.markDirtyWithDebounce();
      });
      this.watchers.push(memoryWatcher);
    } catch {
      // Watchers are best-effort in local environments.
    }

    try {
      const rootWatcher = watch(this.rootDir, { recursive: false }, (_eventType, filename) => {
        if (filename === "MEMORY.md") {
          this.markDirtyWithDebounce();
        }
      });
      this.watchers.push(rootWatcher);
    } catch {
      // Watchers are best-effort in local environments.
    }
  }

  private markDirtyWithDebounce(): void {
    this.dirty = true;

    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
    }

    this.watchDebounceTimer = setTimeout(() => {
      void this.syncMemory("watch_debounce");
    }, this.watchDebounceMs);
  }

  private resolveAllowedPath(filePath: string): string {
    const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(this.rootDir, filePath);

    const isCanonicalRoot = this.includeFiles.some((entry) => path.resolve(this.rootDir, entry) === absolute);
    const isInsideMemoryDir = absolute.startsWith(`${this.memoryDir}${path.sep}`);

    if (!isCanonicalRoot && !isInsideMemoryDir) {
      throw new Error(`Path is outside allowed memory scope: ${filePath}`);
    }

    return absolute;
  }

  private toRepoRelative(absolutePath: string): string {
    return path.relative(this.rootDir, absolutePath).replace(/\\/g, "/");
  }
}

export type { MemoryResult, MemorySearchOptions, MemoryStatus };
