/**
 * The disposable index (§2): derived entirely from the git ledger, deletable
 * and rebuildable with zero data loss. Phase A indexes one ledger entry as
 * one doc (naive per-entry indexing, §9 Phase A); Phase B replaces docs with
 * extracted atomic facts behind this same interface.
 *
 * IndexDb is a local structural interface (same pattern as KVStore in env.ts)
 * so handlers stay testable under node:test: production binds D1 via
 * d1IndexDb, tests use MemoryIndexDb.
 */

export interface IndexedDoc {
  id: string;
  space: string;
  project: string; // slugged
  kind: string; // Phase A: the entry type ("decision" | "context")
  tier: string; // Phase A: always "normal"; Phase B adds "canon"
  body: string;
  sourceFile: string;
  sourceAuthor: string;
  sourceTs: string;
  embedding: number[];
  supersededBy: string | null;
  createdAt: string;
}

export interface RetrievalLogEntry {
  space: string;
  project: string;
  trigger: string;
  query: string;
  returned: { id: string; score: number }[];
  injected: boolean;
  ts: string;
}

export interface IndexDb {
  upsertDocs(docs: IndexedDoc[]): Promise<void>;
  /** Live (unsuperseded) docs; project omitted = whole space. */
  listDocs(space: string, project?: string): Promise<IndexedDoc[]>;
  getLastIndexedSha(space: string): Promise<string | null>;
  setLastIndexedSha(space: string, sha: string): Promise<void>;
  deleteSpace(space: string): Promise<void>;
  logRetrieval(rec: RetrievalLogEntry): Promise<void>;
}

export class MemoryIndexDb implements IndexDb {
  private docs = new Map<string, IndexedDoc>();
  private shas = new Map<string, string>();
  readonly logged: RetrievalLogEntry[] = [];

  async upsertDocs(docs: IndexedDoc[]): Promise<void> {
    for (const d of docs) this.docs.set(`${d.space} ${d.id}`, d);
  }
  async listDocs(space: string, project?: string): Promise<IndexedDoc[]> {
    return [...this.docs.values()].filter(
      (d) =>
        d.space === space &&
        d.supersededBy === null &&
        (project === undefined || d.project === project),
    );
  }
  async getLastIndexedSha(space: string): Promise<string | null> {
    return this.shas.get(space) ?? null;
  }
  async setLastIndexedSha(space: string, sha: string): Promise<void> {
    this.shas.set(space, sha);
  }
  async deleteSpace(space: string): Promise<void> {
    for (const key of this.docs.keys()) {
      if (key.startsWith(`${space} `)) this.docs.delete(key);
    }
    this.shas.delete(space);
  }
  async logRetrieval(rec: RetrievalLogEntry): Promise<void> {
    this.logged.push(rec);
  }
}

/** Minimal structural surface of a D1 prepared statement / database. */
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  run(): Promise<unknown>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
  first(): Promise<Record<string, unknown> | null>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<unknown>;
}

export function encodeEmbedding(v: number[]): ArrayBuffer {
  return new Float32Array(v).buffer as ArrayBuffer;
}

export function decodeEmbedding(b: ArrayBuffer | null): number[] {
  if (!b || b.byteLength === 0) return [];
  return [...new Float32Array(b)];
}

const UPSERT_SQL =
  "INSERT OR REPLACE INTO docs (id, space, project, kind, tier, body, " +
  "source_file, source_author, source_ts, embedding, superseded_by, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function d1IndexDb(db: D1Like): IndexDb {
  return {
    async upsertDocs(docs) {
      if (docs.length === 0) return;
      await db.batch(
        docs.map((d) =>
          db
            .prepare(UPSERT_SQL)
            .bind(
              d.id,
              d.space,
              d.project,
              d.kind,
              d.tier,
              d.body,
              d.sourceFile,
              d.sourceAuthor,
              d.sourceTs,
              encodeEmbedding(d.embedding),
              d.supersededBy,
              d.createdAt,
            ),
        ),
      );
    },
    async listDocs(space, project) {
      const sql =
        "SELECT * FROM docs WHERE space = ? AND superseded_by IS NULL" +
        (project !== undefined ? " AND project = ?" : "");
      const stmt =
        project !== undefined
          ? db.prepare(sql).bind(space, project)
          : db.prepare(sql).bind(space);
      const { results } = await stmt.all();
      return results.map((r) => ({
        id: r.id as string,
        space: r.space as string,
        project: r.project as string,
        kind: r.kind as string,
        tier: r.tier as string,
        body: r.body as string,
        sourceFile: r.source_file as string,
        sourceAuthor: r.source_author as string,
        sourceTs: r.source_ts as string,
        embedding: decodeEmbedding(r.embedding as ArrayBuffer | null),
        supersededBy: (r.superseded_by as string | null) ?? null,
        createdAt: r.created_at as string,
      }));
    },
    async getLastIndexedSha(space) {
      const row = await db
        .prepare("SELECT last_indexed_sha FROM index_state WHERE space = ?")
        .bind(space)
        .first();
      return (row?.last_indexed_sha as string | undefined) ?? null;
    },
    async setLastIndexedSha(space, sha) {
      await db
        .prepare(
          "INSERT OR REPLACE INTO index_state (space, last_indexed_sha) VALUES (?, ?)",
        )
        .bind(space, sha)
        .run();
    },
    async deleteSpace(space) {
      await db.batch([
        db.prepare("DELETE FROM docs WHERE space = ?").bind(space),
        db.prepare("DELETE FROM index_state WHERE space = ?").bind(space),
      ]);
    },
    async logRetrieval(rec) {
      await db
        .prepare(
          "INSERT INTO retrieval_log (space, project, trigger_kind, query, returned, injected, ts) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          rec.space,
          rec.project,
          rec.trigger,
          rec.query,
          JSON.stringify(rec.returned),
          rec.injected ? 1 : 0,
          rec.ts,
        )
        .run();
    },
  };
}
