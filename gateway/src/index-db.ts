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

/** What retrieve()'s candidate generators need from one pass over the live
 *  docs in scope — WITHOUT fetching every body/full row (read-path hardening:
 *  per-query work must not grow with the whole corpus). */
export interface QueryScan {
  /** id + embedding for the newest live docs in scope (recency-capped at
   *  EMBED_SCAN_CAP) — cosine's scan. ArrayLike so the D1 impl can hand back
   *  Float32Array views without boxing 768 floats per doc. */
  embeddings: { id: string; embedding: ArrayLike<number> }[];
  /** entity tags per live doc id in scope (docs with no tags omitted). */
  entitiesByDoc: Map<string, string[]>;
  /** ids of docs whose body contains any query token — a superset of the
   *  docs with nonzero BM25 score, so BM25 over these is exact. */
  tokenMatchIds: string[];
  /** live docs in scope (retrieve()'s reported total). */
  total: number;
}

export interface IndexDb {
  upsertDocs(docs: IndexedDoc[]): Promise<void>;
  /** Live (unsuperseded) docs; project omitted = whole space. */
  listDocs(space: string, project?: string): Promise<IndexedDoc[]>;
  /**
   * Same rows as listDocs but WITHOUT the embedding column.
   *
   * The session-start briefing (renderBriefing) selects canon, questions,
   * recent decisions and an entity manifest — it never touches a vector. Under
   * `SELECT *` every session open decoded the whole project's embeddings into
   * JS arrays for nothing: at 307 docs that is ~940KB of pure waste on the
   * hottest path in the product, growing linearly with the corpus.
   */
  listDocsNoEmbeddings(space: string, project?: string): Promise<IndexedDoc[]>;
  /** Candidate-generation scan for the §5 read path; see QueryScan. */
  queryScan(
    space: string,
    tokens: string[],
    opts?: { project?: string; kinds?: string[] },
  ): Promise<QueryScan>;
  /** Hydrate specific live docs (with entity tags) by id. */
  getDocsByIds(space: string, ids: string[]): Promise<IndexedDoc[]>;
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

/** Zero-copy decode for the query path: a Float32Array view instead of a
 *  boxed number[]. Spreading 768 floats per doc (decodeEmbedding) was a
 *  material share of the free-plan 10ms CPU budget at ~131 docs (the 1102). */
export function decodeEmbeddingF32(b: ArrayBuffer | null): Float32Array {
  if (!b || b.byteLength === 0) return new Float32Array(0);
  return new Float32Array(b);
}

/** Recency cap on cosine's embedding scan — bounds the query path's largest
 *  cost by construction (2000 × 768 F32 cosine ≈ 1–2ms CPU).
 *  ponytail: recency-capped brute-force scan; docs older than the newest
 *  EMBED_SCAN_CAP lose semantic candidacy (BM25/entity paths still see them).
 *  Move to Vectorize (free tier) when a space approaches this cap. */
export const EMBED_SCAN_CAP = 2000;
/** Safety valve on the token-candidate prefilter: bounds hydration and BM25
 *  tokenization; ORDER BY recency so truncation keeps the newest matches.
 *  Was 200 to fit the Free plan's 10ms CPU cap, which silently dropped older
 *  BM25 candidates; the Paid plan's per-invocation budget makes 1000 (~11ms
 *  measured at 1000 docs) cost nothing worth counting. */
export const TOKEN_MATCH_LIMIT = 1000;
/** Bounds the entity-tag rows loaded per query (a few rows per doc). */
export const ENTITY_SCAN_ROW_LIMIT = 4000;
/** D1 caps bound parameters per statement (~100), so IN-list queries chunk. */
const ID_CHUNK = 90;

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
  /**
   * Shared body for listDocs / listDocsNoEmbeddings. `cols` is a literal from
   * this file only — never caller input — so it cannot carry injection.
   */
  const listDocsCols = async (
    cols: string,
    space: string,
    project?: string,
  ): Promise<IndexedDoc[]> => {
    const sql =
      `SELECT ${cols} FROM docs WHERE space = ? AND superseded_by IS NULL` +
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
  };

  return {
    async upsertDocs(docs) {
      if (docs.length === 0) return;
      await db.batch(
        docs.map((d) => db.prepare(UPSERT_SQL).bind(...docBinds(d))),
      );
    },
    async listDocs(space, project) {
      return listDocsCols("*", space, project);
    },
    async listDocsNoEmbeddings(space, project) {
      // Every column the briefing reads, minus the vector blob.
      return listDocsCols(
        "id, space, project, kind, tier, body, source_file, source_author, source_ts, superseded_by",
        space,
        project,
      );
    },

    async queryScan(space, tokens, opts = {}) {
      // Shared live-docs-in-scope predicate; `alias` prefixes columns when
      // the docs table is joined under an alias.
      const scope = (alias = "") =>
        `${alias}space = ? AND ${alias}superseded_by IS NULL` +
        (opts.project !== undefined ? ` AND ${alias}project = ?` : "") +
        (opts.kinds && opts.kinds.length > 0
          ? ` AND ${alias}kind IN (${opts.kinds.map(() => "?").join(", ")})`
          : "");
      const scopeBinds = [
        space,
        ...(opts.project !== undefined ? [opts.project] : []),
        ...(opts.kinds && opts.kinds.length > 0 ? opts.kinds : []),
      ];
      const embStmt = db
        .prepare(
          `SELECT id, embedding FROM docs WHERE ${scope()} ` +
            `ORDER BY source_ts DESC LIMIT ${EMBED_SCAN_CAP}`,
        )
        .bind(...scopeBinds);
      // Capped scan means embeddings.length no longer equals the corpus size;
      // COUNT keeps `total` (and bm25's idf N) honest.
      const countStmt = db
        .prepare(`SELECT COUNT(*) AS n FROM docs WHERE ${scope()}`)
        .bind(...scopeBinds);
      const entStmt = db
        .prepare(
          "SELECT fe.fact_id AS fact_id, fe.entity AS entity " +
            "FROM fact_entities fe JOIN docs d ON d.space = fe.space AND d.id = fe.fact_id " +
            `WHERE ${scope("d.")} ORDER BY d.source_ts DESC LIMIT ${ENTITY_SCAN_ROW_LIMIT}`,
        )
        .bind(...scopeBinds);
      // Tokens come from tokenize(): lowercase [a-z0-9]+, so they are safe
      // inside LIKE patterns (no %/_ metacharacters). Substring matches that
      // are not token matches just hydrate a harmless extra candidate.
      const tokStmt =
        tokens.length > 0
          ? db
              .prepare(
                `SELECT id FROM docs WHERE ${scope()} AND (` +
                  tokens.map(() => "body LIKE ?").join(" OR ") +
                  `) ORDER BY source_ts DESC LIMIT ${TOKEN_MATCH_LIMIT}`,
              )
              .bind(...scopeBinds, ...tokens.map((t) => `%${t}%`))
          : null;
      const [embRes, countRes, entRes, tokRes] = await Promise.all([
        embStmt.all(),
        countStmt.first(),
        entStmt.all(),
        tokStmt ? tokStmt.all() : Promise.resolve({ results: [] }),
      ]);
      const entitiesByDoc = new Map<string, string[]>();
      for (const r of entRes.results) {
        const id = r.fact_id as string;
        const list = entitiesByDoc.get(id) ?? [];
        list.push(r.entity as string);
        entitiesByDoc.set(id, list);
      }
      const embeddings = embRes.results.map((r) => ({
        id: r.id as string,
        embedding: decodeEmbeddingF32(r.embedding as ArrayBuffer | null),
      }));
      return {
        embeddings,
        entitiesByDoc,
        tokenMatchIds: tokRes.results.map((r) => r.id as string),
        total: Number(countRes?.n ?? embeddings.length),
      };
    },
    async getDocsByIds(space, ids) {
      // Chunks run in parallel: a wide candidate set (hundreds of ids) was
      // paying one sequential D1 round trip per 90 ids — measured 1.3s of the
      // guard path's hydrate stage. Wall clock is now ~the slowest chunk.
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        chunks.push(ids.slice(i, i + ID_CHUNK));
      }
      const perChunk = await Promise.all(
        chunks.map(async (chunk) => {
          const ph = chunk.map(() => "?").join(", ");
          const [docRes, tagRes] = await Promise.all([
            db
              .prepare(
                // Explicit column list WITHOUT embedding: hydration feeds
                // bm25/render, which never touch vectors — fetching them here
                // decoded every candidate's 768 floats a second time (the other
                // half of the 1102 CPU blowup).
                "SELECT id, space, project, kind, tier, body, source_file, " +
                  "source_author, source_ts, superseded_by, created_at, source_id " +
                  `FROM docs WHERE space = ? AND superseded_by IS NULL AND id IN (${ph})`,
              )
              .bind(space, ...chunk)
              .all(),
            db
              .prepare(
                `SELECT fact_id, entity FROM fact_entities WHERE space = ? AND fact_id IN (${ph})`,
              )
              .bind(space, ...chunk)
              .all(),
          ]);
          const tags = new Map<string, string[]>();
          for (const r of tagRes.results) {
            const id = r.fact_id as string;
            const list = tags.get(id) ?? [];
            list.push(r.entity as string);
            tags.set(id, list);
          }
          return docRes.results.map((r) =>
            rowToDoc(r, tags.get(r.id as string) ?? []),
          );
        }),
      );
      return perChunk.flat();
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
            "FROM memory_feedback WHERE space = ? GROUP BY fact_id HAVING net > 0 LIMIT 500",
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
