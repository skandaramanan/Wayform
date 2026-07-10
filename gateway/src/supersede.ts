/**
 * Phase B2 supersession (roadmap §4): entity-scoped candidate generation,
 * conservative LLM judging, sync conflict surfacing on write, async auto-link
 * on ingest. Fail-open everywhere — supersession never blocks writes or reads.
 */
import type { Embedder } from "./retrieval.js";
import type { GenText } from "./extract.js";
import type { IndexDb, IndexedDoc, SupersessionLogEntry } from "./index-db.js";
import { cosineTopK } from "./rank.js";

export const SYNC_COSINE_FLOOR = 0.7;
export const ASYNC_COSINE_FLOOR = 0.6;
export const SYNC_CANDIDATE_K = 10;
export const ASYNC_CANDIDATE_K = 10;

export type JudgeVerdict = "replaces" | "contradicts" | "relates" | "uncertain";

export interface JudgeResult {
  verdict: JudgeVerdict;
  oldFactId: string;
  oldBody: string;
  reason: string;
}

export interface ConflictHit {
  factId: string;
  body: string;
  reason: string;
  verdict: JudgeVerdict;
}

function sharesEntity(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((e) => set.has(e));
}

/** Entity-scoped cosine top-K; project-wide fallback when new fact has no entities. */
export function supersessionCandidates(
  liveFacts: IndexedDoc[],
  newFact: IndexedDoc,
  topK: number,
  cosineFloor: number,
): IndexedDoc[] {
  let pool = liveFacts.filter((d) => d.id !== newFact.id);
  if (newFact.entities.length > 0) {
    pool = pool.filter((d) => sharesEntity(d.entities, newFact.entities));
  }
  if (pool.length === 0) return [];
  const ranked = cosineTopK(pool, newFact.embedding, topK).filter(
    (s) => s.score >= cosineFloor,
  );
  const byId = new Map(pool.map((d) => [d.id, d]));
  return ranked.map((s) => byId.get(s.id)!).filter(Boolean);
}

export function buildJudgePrompt(
  newFact: { body: string; kind: string },
  oldFact: { id: string; body: string; kind: string },
): string {
  return [
    "You judge whether a NEW planning fact supersedes, contradicts, or merely relates to an OLD fact.",
    'Output ONLY JSON: {"verdict":"replaces|contradicts|relates|uncertain","reason":"one sentence"}',
    "Verdict rules:",
    '- "replaces" — NEW directly updates/obsoletes OLD (same topic, intentional replacement).',
    '- "contradicts" — both cannot be true; replacement is unclear or partial.',
    '- "relates" — same area; both can coexist.',
    '- "uncertain" — insufficient information to decide.',
    "Read only what each fact states. Do not infer beyond the text.",
    "Canon/standing-rule replacements require explicit replacement language in NEW.",
    "",
    `NEW (${newFact.kind}): ${newFact.body}`,
    `OLD (${oldFact.kind}, id=${oldFact.id}): ${oldFact.body}`,
  ].join("\n");
}

export function parseJudgeVerdict(text: string): {
  verdict: JudgeVerdict;
  reason: string;
} {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = (fenced ? fenced[1] : text).trim();
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    const parsed = JSON.parse(
      start >= 0 && end > start ? body.slice(start, end + 1) : body,
    ) as { verdict?: string; reason?: string };
    const v = parsed.verdict;
    if (
      v === "replaces" ||
      v === "contradicts" ||
      v === "relates" ||
      v === "uncertain"
    ) {
      return { verdict: v, reason: String(parsed.reason ?? "") };
    }
  } catch {
    // fail-open
  }
  return { verdict: "uncertain", reason: "parse-failed" };
}

export async function judgePair(
  gen: GenText,
  newFact: { body: string; kind: string },
  oldFact: { id: string; body: string; kind: string },
): Promise<JudgeResult> {
  const out = await gen(buildJudgePrompt(newFact, oldFact));
  const { verdict, reason } = parseJudgeVerdict(out);
  return {
    verdict,
    oldFactId: oldFact.id,
    oldBody: oldFact.body,
    reason,
  };
}

async function logJudgment(
  db: IndexDb,
  entry: Omit<SupersessionLogEntry, "autoLinked"> & { autoLinked: boolean },
): Promise<void> {
  try {
    await db.logSupersession(entry);
  } catch {
    // audit logging must never break ingest or writes
  }
}

export async function applySupersession(
  db: IndexDb,
  gen: GenText | null,
  space: string,
  project: string,
  newFacts: IndexedDoc[],
  opts: { authorSupersedes?: string[] } = {},
): Promise<void> {
  if (newFacts.length === 0) return;
  const primaryId = newFacts[0].id;
  const live = await db.listDocs(space, project);
  const skip = new Set(opts.authorSupersedes ?? []);
  const ts = () => new Date().toISOString();

  for (const oldId of opts.authorSupersedes ?? []) {
    if (!live.some((d) => d.id === oldId)) continue;
    await db.markSuperseded(space, oldId, primaryId);
    await logJudgment(db, {
      space,
      project,
      newFactId: primaryId,
      oldFactId: oldId,
      verdict: "replaces",
      autoLinked: true,
      reason: "author-supersedes",
      ts: ts(),
    });
    const old = live.find((d) => d.id === oldId);
    if (old) old.supersededBy = primaryId;
  }

  if (!gen) return;

  for (const newFact of newFacts) {
    const cands = supersessionCandidates(
      live,
      newFact,
      ASYNC_CANDIDATE_K,
      ASYNC_COSINE_FLOOR,
    ).filter((c) => !skip.has(c.id));
    for (const old of cands) {
      const result = await judgePair(
        gen,
        { body: newFact.body, kind: newFact.kind },
        old,
      );
      const autoLinked = result.verdict === "replaces";
      await logJudgment(db, {
        space,
        project,
        newFactId: newFact.id,
        oldFactId: old.id,
        verdict: result.verdict,
        autoLinked,
        reason: result.reason,
        ts: ts(),
      });
      if (autoLinked) {
        await db.markSuperseded(space, old.id, newFact.id);
        old.supersededBy = newFact.id;
      }
    }
  }
}

export async function detectWriteConflicts(
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  space: string,
  project: string,
  entryBody: string,
  opts: { skipIds?: string[] } = {},
): Promise<ConflictHit[]> {
  if (!embed || !gen) return [];
  const skip = new Set(opts.skipIds ?? []);
  const live = (await db.listDocs(space, project)).filter(
    (d) => !skip.has(d.id),
  );
  if (live.length === 0) return [];

  let queryVec: number[];
  try {
    [queryVec] = await embed([entryBody]);
  } catch {
    return [];
  }
  if (!queryVec || queryVec.length === 0) return [];

  const pseudo: IndexedDoc = {
    id: "__pending__",
    space,
    project,
    kind: "decision",
    tier: "normal",
    body: entryBody,
    sourceFile: "",
    sourceAuthor: "",
    sourceTs: new Date().toISOString(),
    embedding: queryVec,
    supersededBy: null,
    createdAt: new Date().toISOString(),
    sourceId: "",
    entities: [],
  };

  const cands = supersessionCandidates(
    live,
    pseudo,
    SYNC_CANDIDATE_K,
    SYNC_COSINE_FLOOR,
  );
  const hits: ConflictHit[] = [];
  const ts = new Date().toISOString();

  for (const old of cands) {
    const result = await judgePair(
      gen,
      { body: entryBody, kind: "decision" },
      old,
    );
    await logJudgment(db, {
      space,
      project,
      newFactId: "(pending)",
      oldFactId: old.id,
      verdict: result.verdict,
      autoLinked: false,
      reason: result.reason,
      ts,
    });
    if (result.verdict === "contradicts" || result.verdict === "uncertain") {
      hits.push({
        factId: old.id,
        body: old.body,
        reason: result.reason,
        verdict: result.verdict,
      });
    }
  }
  return hits;
}

export function formatWriteResult(
  entry: { type: string; author: string; timestamp: string; file: string },
  project: string,
  conflicts: ConflictHit[],
  authorSupersedes: string[],
): string {
  let text = `Recorded ${entry.type} in '${project}' as ${entry.author} at ${entry.timestamp} (${entry.file}).`;
  if (authorSupersedes.length > 0) {
    text += `\n\nSupersedes: ${authorSupersedes.join(", ")}`;
  }
  if (conflicts.length > 0) {
    text +=
      "\n\n⚠ Possible conflicts with existing memory (not auto-resolved):";
    for (const c of conflicts) {
      const snippet =
        c.body.length > 120 ? `${c.body.slice(0, 117)}...` : c.body;
      text += `\n- [${c.factId}] "${snippet}" — ${c.verdict}: ${c.reason}`;
    }
  }
  return text;
}
