/**
 * In-memory IndexDb used by the gateway test suites. Lives in its own module,
 * imported by NOTHING under src/, so it can never ride into the deployed
 * Worker bundle. Mirrors d1IndexDb semantics (ordering, caps, LIKE matching)
 * so tests exercise production truncation behavior.
 */
import type {
  FeedbackEntry,
  GoldenCandidate,
  IndexDb,
  IndexedDoc,
  QueryScan,
  RetrievalLogEntry,
  SupersessionLogEntry,
} from "./index-db.js";
import { EMBED_SCAN_CAP, TOKEN_MATCH_LIMIT, ENTITY_SCAN_ROW_LIMIT } from "./index-db.js";

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
  async queryScan(
    space: string,
    tokens: string[],
    opts: { project?: string; kinds?: string[] } = {},
  ): Promise<QueryScan> {
    let docs = await this.listDocs(space, opts.project);
    if (opts.kinds && opts.kinds.length > 0) {
      docs = docs.filter((d) => opts.kinds!.includes(d.kind));
    }
    // Mirror the D1 impl: recency order, then the same caps, so tests
    // exercise production truncation semantics.
    const sorted = [...docs].sort((a, b) =>
      a.sourceTs < b.sourceTs ? 1 : a.sourceTs > b.sourceTs ? -1 : 0,
    );
    const entitiesByDoc = new Map<string, string[]>();
    let entityRows = 0;
    for (const d of sorted) {
      const ents = d.entities ?? [];
      if (ents.length === 0) continue;
      if (entityRows + ents.length > ENTITY_SCAN_ROW_LIMIT) break;
      entitiesByDoc.set(d.id, ents);
      entityRows += ents.length;
    }
    // Substring match mirrors the D1 impl's LIKE '%token%' semantics.
    const lowered = tokens.map((t) => t.toLowerCase());
    return {
      embeddings: sorted
        .slice(0, EMBED_SCAN_CAP)
        .map((d) => ({ id: d.id, embedding: d.embedding })),
      entitiesByDoc,
      tokenMatchIds: sorted
        .filter((d) => {
          const body = d.body.toLowerCase();
          return lowered.some((t) => body.includes(t));
        })
        .slice(0, TOKEN_MATCH_LIMIT)
        .map((d) => d.id),
      total: docs.length,
    };
  }
  async getDocsByIds(space: string, ids: string[]): Promise<IndexedDoc[]> {
    const want = new Set(ids);
    return (await this.listDocs(space)).filter((d) => want.has(d.id));
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
