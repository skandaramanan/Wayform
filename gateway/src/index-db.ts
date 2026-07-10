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
  sourceId: string; // ledger entry id; groups the fact set for idempotent re-ingest
  entities: string[]; // normalized tags; hydrated on listDocs, written to fact_entities
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

export interface SupersessionLogEntry {
  space: string;
  project: string;
  newFactId: string;
  oldFactId: string;
  verdict: string;
  autoLinked: boolean;
  reason: string;
  ts: string;
}

export interface FeedbackEntry {
  space: string;
  project: string;
  factId: string;
  member: string;
  verdict: string; // "useful" | "wrong" | "stale"
  ts: string;
}

export interface GoldenCandidate {
  space: string;
  project: string;
  query: string;
  expectedFactId: string;
  note?: string;
  ts: string;
}

export interface IndexDb {
  upsertDocs(docs: IndexedDoc[]): Promise<void>;
  /** Live (unsuperseded) docs; project omitted = whole space. */
  listDocs(space: string, project?: string): Promise<IndexedDoc[]>;
  /** Fetch one doc by id regardless of superseded_by (briefing / audit). */
  getDoc(space: string, id: string): Promise<IndexedDoc | null>;
  getLastIndexedSha(space: string): Promise<string | null>;
  setLastIndexedSha(space: string, sha: string): Promise<void>;
  deleteSpace(space: string): Promise<void>;
  logRetrieval(rec: RetrievalLogEntry): Promise<void>;
  recordFeedback(entry: FeedbackEntry): Promise<void>;
  /** fact id → net-negative feedback count (wrong+stale minus useful), only
   *  facts with net > 0. Keyed by space (fact ids are space-unique). */
  feedbackPenalties(space: string): Promise<Map<string, number>>;
  recordGoldenCandidate(entry: GoldenCandidate): Promise<void>;
  listRetrievalLog(
    space: string,
    sinceIso: string,
    limit: number,
  ): Promise<RetrievalLogEntry[]>;
  /** Delete-then-insert every fact for one ledger entry, in one batch —
   *  idempotent under non-deterministic extraction (roadmap §3). */
  replaceBySource(
    space: string,
    sourceId: string,
    docs: IndexedDoc[],
  ): Promise<void>;
  markSuperseded(
    space: string,
    oldFactId: string,
    newFactId: string,
  ): Promise<void>;
  clearSupersessionPointersTo(
    space: string,
    deletedIds: string[],
  ): Promise<void>;
  idsBySource(space: string, sourceId: string): Promise<string[]>;
  logSupersession(entry: SupersessionLogEntry): Promise<void>;
  recentConflictLogs(
    space: string,
    project: string,
    sinceIso: string,
    limit?: number,
  ): Promise<SupersessionLogEntry[]>;
  clearAllSupersession(space: string): Promise<number>;
  listSupersessionAudit(
    space: string,
    limit: number,
    autoLinkedOnly: boolean,
  ): Promise<SupersessionLogEntry[]>;
}

function rowToDoc(
  r: Record<string, unknown>,
  entities: string[] = [],
): IndexedDoc {
  return {
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
    sourceId: (r.source_id as string | null) ?? "",
    entities,
  };
}

export class MemoryIndexDb implements IndexDb {
  private docs = new Map<string, IndexedDoc>();
  private shas = new Map<string, string>();
  readonly logged: RetrievalLogEntry[] = [];
  readonly supersessionLogged: SupersessionLogEntry[] = [];

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
  async getDoc(space: string, id: string): Promise<IndexedDoc | null> {
    return this.docs.get(`${space} ${id}`) ?? null;
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
  readonly feedbackLogged: FeedbackEntry[] = [];
  async recordFeedback(entry: FeedbackEntry): Promise<void> {
    this.feedbackLogged.push(entry);
  }
  async feedbackPenalties(space: string): Promise<Map<string, number>> {
    const net = new Map<string, number>();
    for (const f of this.feedbackLogged) {
      if (f.space !== space) continue;
      net.set(
        f.factId,
        (net.get(f.factId) ?? 0) + (f.verdict === "useful" ? -1 : 1),
      );
    }
    const out = new Map<string, number>();
    for (const [id, n] of net) if (n > 0) out.set(id, n);
    return out;
  }
  readonly goldenCandidates: GoldenCandidate[] = [];
  async recordGoldenCandidate(entry: GoldenCandidate): Promise<void> {
    this.goldenCandidates.push(entry);
  }
  async listRetrievalLog(
    space: string,
    sinceIso: string,
    limit: number,
  ): Promise<RetrievalLogEntry[]> {
    const since = Date.parse(sinceIso);
    return this.logged
      .filter((r) => r.space === space && Date.parse(r.ts) >= since)
      .slice(-limit)
      .reverse();
  }
  async replaceBySource(
    space: string,
    sourceId: string,
    docs: IndexedDoc[],
  ): Promise<void> {
    const deleting = await this.idsBySource(space, sourceId);
    await this.clearSupersessionPointersTo(space, deleting);
    for (const [key, d] of this.docs) {
      if (d.space === space && d.sourceId === sourceId) this.docs.delete(key);
    }
    for (const d of docs) this.docs.set(`${d.space} ${d.id}`, d);
  }
  async markSuperseded(
    space: string,
    oldFactId: string,
    newFactId: string,
  ): Promise<void> {
    const d = this.docs.get(`${space} ${oldFactId}`);
    if (d) d.supersededBy = newFactId;
  }
  async clearSupersessionPointersTo(
    space: string,
    deletedIds: string[],
  ): Promise<void> {
    if (deletedIds.length === 0) return;
    const gone = new Set(deletedIds);
    for (const d of this.docs.values()) {
      if (d.space === space && d.supersededBy && gone.has(d.supersededBy)) {
        d.supersededBy = null;
      }
    }
  }
  async idsBySource(space: string, sourceId: string): Promise<string[]> {
    return [...this.docs.values()]
      .filter((d) => d.space === space && d.sourceId === sourceId)
      .map((d) => d.id);
  }
  async logSupersession(entry: SupersessionLogEntry): Promise<void> {
    this.supersessionLogged.push(entry);
  }
  async recentConflictLogs(
    space: string,
    project: string,
    sinceIso: string,
    limit = 10,
  ): Promise<SupersessionLogEntry[]> {
    const since = Date.parse(sinceIso);
    const seen = new Set<string>();
    const out: SupersessionLogEntry[] = [];
    for (const e of [...this.supersessionLogged].reverse()) {
      if (e.space !== space || e.project !== project) continue;
      if (e.verdict !== "contradicts" && e.verdict !== "uncertain") continue;
      if (Date.parse(e.ts) < since) continue;
      if (seen.has(e.oldFactId)) continue;
      seen.add(e.oldFactId);
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }
  async clearAllSupersession(space: string): Promise<number> {
    let n = 0;
    for (const d of this.docs.values()) {
      if (d.space === space && d.supersededBy) {
        d.supersededBy = null;
        n++;
      }
    }
    return n;
  }
  async listSupersessionAudit(
    space: string,
    limit: number,
    autoLinkedOnly: boolean,
  ): Promise<SupersessionLogEntry[]> {
    return [...this.supersessionLogged]
      .filter((e) => e.space === space && (!autoLinkedOnly || e.autoLinked))
      .slice(-limit)
      .reverse();
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
  "source_file, source_author, source_ts, embedding, superseded_by, created_at, source_id) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function docBinds(d: IndexedDoc): unknown[] {
  return [
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
    d.sourceId,
  ];
}

export function d1IndexDb(db: D1Like): IndexDb {
  return {
    async upsertDocs(docs) {
      if (docs.length === 0) return;
      await db.batch(
        docs.map((d) => db.prepare(UPSERT_SQL).bind(...docBinds(d))),
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
      const { results: tagRows } = await db
        .prepare("SELECT fact_id, entity FROM fact_entities WHERE space = ?")
        .bind(space)
        .all();
      const tags = new Map<string, string[]>();
      for (const r of tagRows) {
        const id = r.fact_id as string;
        const list = tags.get(id) ?? [];
        list.push(r.entity as string);
        tags.set(id, list);
      }
      return results.map((r) => rowToDoc(r, tags.get(r.id as string) ?? []));
    },
    async getDoc(space, id) {
      const row = await db
        .prepare("SELECT * FROM docs WHERE space = ? AND id = ?")
        .bind(space, id)
        .first();
      if (!row) return null;
      const { results: tagRows } = await db
        .prepare(
          "SELECT entity FROM fact_entities WHERE space = ? AND fact_id = ?",
        )
        .bind(space, id)
        .all();
      return rowToDoc(
        row,
        tagRows.map((r) => r.entity as string),
      );
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
    async recordFeedback(entry) {
      await db
        .prepare(
          "INSERT INTO memory_feedback (space, project, fact_id, member, verdict, ts) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          entry.space,
          entry.project,
          entry.factId,
          entry.member,
          entry.verdict,
          entry.ts,
        )
        .run();
    },
    async feedbackPenalties(space) {
      const { results } = await db
        .prepare(
          "SELECT fact_id, SUM(CASE WHEN verdict = 'useful' THEN -1 ELSE 1 END) AS net " +
            "FROM memory_feedback WHERE space = ? GROUP BY fact_id HAVING net > 0",
        )
        .bind(space)
        .all();
      const out = new Map<string, number>();
      for (const r of results) out.set(r.fact_id as string, Number(r.net));
      return out;
    },
    async recordGoldenCandidate(entry) {
      await db
        .prepare(
          "INSERT INTO golden_candidate (space, project, query, expected_fact_id, note, ts) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          entry.space,
          entry.project,
          entry.query,
          entry.expectedFactId,
          entry.note ?? "",
          entry.ts,
        )
        .run();
    },
    async listRetrievalLog(space, sinceIso, limit) {
      const { results } = await db
        .prepare(
          "SELECT * FROM retrieval_log WHERE space = ? AND ts >= ? ORDER BY ts DESC LIMIT ?",
        )
        .bind(space, sinceIso, limit)
        .all();
      return results.map((r) => ({
        space: r.space as string,
        project: r.project as string,
        trigger: r.trigger_kind as string,
        query: r.query as string,
        returned: JSON.parse((r.returned as string) ?? "[]"),
        injected: (r.injected as number) === 1,
        ts: r.ts as string,
      }));
    },
    async replaceBySource(space, sourceId, docs) {
      const { results: existing } = await db
        .prepare("SELECT id FROM docs WHERE space = ? AND source_id = ?")
        .bind(space, sourceId)
        .all();
      const deleting = existing.map((r) => r.id as string);
      const stmts: D1Stmt[] = [];
      if (deleting.length > 0) {
        const placeholders = deleting.map(() => "?").join(", ");
        stmts.push(
          db
            .prepare(
              `UPDATE docs SET superseded_by = NULL WHERE space = ? AND superseded_by IN (${placeholders})`,
            )
            .bind(space, ...deleting),
        );
      }
      stmts.push(
        db
          .prepare(
            "DELETE FROM fact_entities WHERE space = ? AND fact_id IN " +
              "(SELECT id FROM docs WHERE space = ? AND source_id = ?)",
          )
          .bind(space, space, sourceId),
        db
          .prepare("DELETE FROM docs WHERE space = ? AND source_id = ?")
          .bind(space, sourceId),
      );
      for (const d of docs) {
        stmts.push(db.prepare(UPSERT_SQL).bind(...docBinds(d)));
        for (const e of d.entities) {
          stmts.push(
            db
              .prepare(
                "INSERT OR REPLACE INTO fact_entities (space, fact_id, entity) VALUES (?, ?, ?)",
              )
              .bind(d.space, d.id, e),
          );
        }
      }
      await db.batch(stmts);
    },
    async markSuperseded(space, oldFactId, newFactId) {
      await db
        .prepare("UPDATE docs SET superseded_by = ? WHERE space = ? AND id = ?")
        .bind(newFactId, space, oldFactId)
        .run();
    },
    async clearSupersessionPointersTo(space, deletedIds) {
      if (deletedIds.length === 0) return;
      const placeholders = deletedIds.map(() => "?").join(", ");
      await db
        .prepare(
          `UPDATE docs SET superseded_by = NULL WHERE space = ? AND superseded_by IN (${placeholders})`,
        )
        .bind(space, ...deletedIds)
        .run();
    },
    async idsBySource(space, sourceId) {
      const { results } = await db
        .prepare("SELECT id FROM docs WHERE space = ? AND source_id = ?")
        .bind(space, sourceId)
        .all();
      return results.map((r) => r.id as string);
    },
    async logSupersession(entry) {
      await db
        .prepare(
          "INSERT INTO supersession_log (space, project, new_fact_id, old_fact_id, verdict, auto_linked, reason, ts) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          entry.space,
          entry.project,
          entry.newFactId,
          entry.oldFactId,
          entry.verdict,
          entry.autoLinked ? 1 : 0,
          entry.reason,
          entry.ts,
        )
        .run();
    },
    async recentConflictLogs(space, project, sinceIso, limit = 10) {
      const { results } = await db
        .prepare(
          "SELECT * FROM supersession_log WHERE space = ? AND project = ? " +
            "AND verdict IN ('contradicts', 'uncertain') AND ts >= ? " +
            "ORDER BY ts DESC LIMIT ?",
        )
        .bind(space, project, sinceIso, limit * 3)
        .all();
      const seen = new Set<string>();
      const out: SupersessionLogEntry[] = [];
      for (const r of results) {
        const oldId = r.old_fact_id as string;
        if (seen.has(oldId)) continue;
        seen.add(oldId);
        out.push({
          space: r.space as string,
          project: r.project as string,
          newFactId: r.new_fact_id as string,
          oldFactId: oldId,
          verdict: r.verdict as string,
          autoLinked: (r.auto_linked as number) === 1,
          reason: (r.reason as string) ?? "",
          ts: r.ts as string,
        });
        if (out.length >= limit) break;
      }
      return out;
    },
    async clearAllSupersession(space) {
      const row = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM docs WHERE space = ? AND superseded_by IS NOT NULL",
        )
        .bind(space)
        .first();
      const n = (row?.n as number) ?? 0;
      await db
        .prepare(
          "UPDATE docs SET superseded_by = NULL WHERE space = ? AND superseded_by IS NOT NULL",
        )
        .bind(space)
        .run();
      return n;
    },
    async listSupersessionAudit(space, limit, autoLinkedOnly) {
      const sql = autoLinkedOnly
        ? "SELECT * FROM supersession_log WHERE space = ? AND auto_linked = 1 ORDER BY ts DESC LIMIT ?"
        : "SELECT * FROM supersession_log WHERE space = ? ORDER BY ts DESC LIMIT ?";
      const { results } = await db.prepare(sql).bind(space, limit).all();
      return results.map((r) => ({
        space: r.space as string,
        project: r.project as string,
        newFactId: r.new_fact_id as string,
        oldFactId: r.old_fact_id as string,
        verdict: r.verdict as string,
        autoLinked: (r.auto_linked as number) === 1,
        reason: (r.reason as string) ?? "",
        ts: r.ts as string,
      }));
    },
  };
}
