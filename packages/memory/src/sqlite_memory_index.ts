import { DatabaseSync } from "node:sqlite";

export type IndexedFile = {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  updatedAt: string;
};

export type IndexedChunk = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embedding: number[] | null;
  updatedAt: string;
};

export type KeywordHit = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  bm25: number;
};

export type VectorCandidate = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
};

export class SqliteMemoryIndex {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);

      CREATE TABLE IF NOT EXISTS embedding_cache (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        hash TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        id UNINDEXED,
        path UNINDEXED,
        text
      );
    `);
  }

  upsertFile(file: IndexedFile): void {
    const stmt = this.db.prepare(`
      INSERT INTO files(path, hash, mtime, size, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        mtime = excluded.mtime,
        size = excluded.size,
        updated_at = excluded.updated_at
    `);

    stmt.run(file.path, file.hash, file.mtime, file.size, file.updatedAt);
  }

  getFile(path: string): IndexedFile | null {
    const row = this.db
      .prepare(`SELECT path, hash, mtime, size, updated_at FROM files WHERE path = ? LIMIT 1`)
      .get(path) as
      | {
          path: string;
          hash: string;
          mtime: number;
          size: number;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      path: row.path,
      hash: row.hash,
      mtime: row.mtime,
      size: row.size,
      updatedAt: row.updated_at
    };
  }

  listFiles(): IndexedFile[] {
    const rows = this.db
      .prepare(`SELECT path, hash, mtime, size, updated_at FROM files ORDER BY path ASC`)
      .all() as Array<{ path: string; hash: string; mtime: number; size: number; updated_at: string }>;

    return rows.map((row) => ({
      path: row.path,
      hash: row.hash,
      mtime: row.mtime,
      size: row.size,
      updatedAt: row.updated_at
    }));
  }

  deleteFile(path: string): void {
    const chunkIds = this.db.prepare(`SELECT id FROM chunks WHERE path = ?`).all(path) as Array<{ id: string }>;

    const deleteChunk = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    const deleteFts = this.db.prepare(`DELETE FROM chunk_fts WHERE id = ?`);

    for (const { id } of chunkIds) {
      deleteChunk.run(id);
      deleteFts.run(id);
    }

    this.db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
  }

  replaceChunksForFile(path: string, chunks: IndexedChunk[]): void {
    this.deleteChunksForPath(path);

    const insertChunk = this.db.prepare(`
      INSERT INTO chunks(id, path, start_line, end_line, text, hash, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.db.prepare(`
      INSERT INTO chunk_fts(id, path, text)
      VALUES (?, ?, ?)
    `);

    for (const chunk of chunks) {
      insertChunk.run(
        chunk.id,
        chunk.path,
        chunk.startLine,
        chunk.endLine,
        chunk.text,
        chunk.hash,
        chunk.embedding ? JSON.stringify(chunk.embedding) : null,
        chunk.updatedAt
      );
      insertFts.run(chunk.id, chunk.path, chunk.text);
    }
  }

  getCachedEmbedding(provider: string, model: string, hash: string): number[] | null {
    const row = this.db
      .prepare(
        `SELECT embedding FROM embedding_cache WHERE provider = ? AND model = ? AND hash = ? LIMIT 1`
      )
      .get(provider, model, hash) as { embedding: string } | undefined;

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.embedding) as number[];
    } catch {
      return null;
    }
  }

  setCachedEmbedding(provider: string, model: string, hash: string, embedding: number[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO embedding_cache(provider, model, hash, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `);

    stmt.run(provider, model, hash, JSON.stringify(embedding), new Date().toISOString());
  }

  queryKeyword(query: string, limit: number): KeywordHit[] {
    const sanitized = query.trim();
    if (!sanitized) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
          SELECT c.id, c.path, c.start_line, c.end_line, c.text, bm25(chunk_fts) AS bm25_score
          FROM chunk_fts
          JOIN chunks c ON c.id = chunk_fts.id
          WHERE chunk_fts MATCH ?
          ORDER BY bm25_score
          LIMIT ?
        `
      )
      .all(sanitized, limit) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      bm25_score: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      bm25: row.bm25_score
    }));
  }

  listVectorCandidates(limit = 2000): VectorCandidate[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, path, start_line, end_line, text, embedding
        FROM chunks
        WHERE embedding IS NOT NULL
        LIMIT ?
      `
      )
      .all(limit) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
    }>;

    return rows
      .map((row) => {
        try {
          return {
            id: row.id,
            path: row.path,
            startLine: row.start_line,
            endLine: row.end_line,
            text: row.text,
            embedding: JSON.parse(row.embedding) as number[]
          };
        } catch {
          return null;
        }
      })
      .filter((row): row is VectorCandidate => Boolean(row));
  }

  getFileCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM files`).get() as { count: number };
    return row.count;
  }

  getChunkCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM chunks`).get() as { count: number };
    return row.count;
  }

  private deleteChunksForPath(path: string): void {
    const ids = this.db.prepare(`SELECT id FROM chunks WHERE path = ?`).all(path) as Array<{ id: string }>;
    const deleteChunk = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    const deleteFts = this.db.prepare(`DELETE FROM chunk_fts WHERE id = ?`);

    for (const { id } of ids) {
      deleteChunk.run(id);
      deleteFts.run(id);
    }
  }
}
