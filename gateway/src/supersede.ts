/**
 * Phase B2 supersession (roadmap §4): entity-scoped candidate generation,
 * conservative LLM judging, sync conflict surfacing on write, async auto-link
 * on ingest. Fail-open everywhere — supersession never blocks writes or reads.
 */
import type { Embedder } from "./retrieval.js";
import type { GenText } from "./extract.js";
import type { IndexDb, IndexedDoc, SupersessionLogEntry } from "./index-db.js";
import { EMBED_SCAN_CAP } from "./index-db.js";
import { cosineTopK } from "./rank.js";

export const SYNC_COSINE_FLOOR = 0.7;
export const ASYNC_COSINE_FLOOR = 0.6;
export const SYNC_CANDIDATE_K = 10;
export const ASYNC_CANDIDATE_K = 10;
/**
 * Cap on how many candidates the sync write-path conflict check sends to the
 * LLM judge. detectWriteConflicts runs BEFORE write_context returns, so every
 * judge call is user-facing latency; candidates arrive cosine-sorted, so the
 * top few are the only plausible conflicts anyway. Async ingest still judges
 * the full ASYNC_CANDIDATE_K set off the hot path.
 */
export const SYNC_JUDGE_LIMIT = 2;

/**
 * Near-duplicate write gate: a new payload whose top cosine against any live
 * fact clears this floor is (when enforcement is on) not committed at all —
 * the agent is told which fact already covers it. Lets agents write liberally
 * without pre-checking; the server arbitrates. bge-base bands: identical ≈1.0,
 * trivial rewording ~0.96–0.99, real paraphrase ~0.88–0.95.
 */
export const DUP_COSINE_FLOOR = 0.95;
/**
 * Log-only rollout switch: while false, the gate computes and logs a
 * `dup_gate` line (plus a supersession_log "duplicate" row when over floor)
 * on every write but never blocks. Flip to true after ~a week of real score
 * data from Workers Logs confirms the floor doesn't catch legit paraphrases.
 */
export const DUP_GATE_ENFORCE = false;

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

export interface DuplicateHit {
  factId: string;
  body: string;
  score: number;
}

/** What the sync write-path check reports back to write_context. */
export interface WriteCheck {
  /** Set only when the dup gate is ENFORCING and a live fact clears the
   *  floor — the caller must then skip the commit entirely. */
  duplicate: DuplicateHit | null;
  conflicts: ConflictHit[];
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
  opts: {
    skipIds?: string[];
    kind?: string;
    timeoutMs?: number;
    /** false when the author passed explicit `supersedes` ids — deliberate
     *  replacement must never be second-guessed by the dup gate (bge-base
     *  scores small numeric edits ~0.97+, so a legit correction would
     *  otherwise be blocked by its own predecessor). */
    dedupe?: boolean;
    /** Test seam; production behavior comes from DUP_GATE_ENFORCE. */
    enforceDup?: boolean;
  } = {},
): Promise<WriteCheck> {
  const none: WriteCheck = { duplicate: null, conflicts: [] };
  if (!embed || !gen) return none;
  const kind = opts.kind ?? "decision";
  const skip = new Set(opts.skipIds ?? []);
  // Cap like retrieval's embedding scan — full-pool listDocs grows with the
  // corpus and burns write-path CPU/latency for dup + conflict scoring.
  const live = (await db.listDocs(space, project))
    .filter((d) => !skip.has(d.id))
    .sort((a, b) => (a.sourceTs < b.sourceTs ? 1 : -1))
    .slice(0, EMBED_SCAN_CAP);
  if (live.length === 0) return none;

  let queryVec: number[];
  try {
    [queryVec] = await embed([entryBody]);
  } catch {
    return none;
  }
  if (!queryVec || queryVec.length === 0) return none;

  // ── Near-duplicate gate ────────────────────────────────────────────────
  // Full live-pool cosine (the pseudo-fact has no entities, so the conflict
  // path below scans the same pool anyway). Every failure path above stores;
  // a write is only ever blocked on a positive high-confidence match.
  // ponytail: compares the raw payload embedding against extracted-fact
  // embeddings, so a long multi-fact duplicate can score <floor and slip
  // through — best-effort by design; async supersession catches the rest.
  const enforceDup = opts.enforceDup ?? DUP_GATE_ENFORCE;
  if (opts.dedupe ?? true) {
    const [top] = cosineTopK(live, queryVec, 1);
    const wouldBlock = top !== undefined && top.score >= DUP_COSINE_FLOOR;
    // Calibration instrument: logged on EVERY gated write from day one.
    console.log(
      JSON.stringify({
        evt: "dup_gate",
        topScore: top ? Number(top.score.toFixed(4)) : null,
        wouldBlock,
        enforced: enforceDup,
      }),
    );
    if (wouldBlock) {
      const dupOf = live.find((d) => d.id === top.id);
      await logJudgment(db, {
        space,
        project,
        newFactId: enforceDup ? "(blocked)" : "(pending)",
        oldFactId: top.id,
        verdict: "duplicate",
        autoLinked: false,
        reason:
          `cosine=${top.score.toFixed(3)}` + (enforceDup ? "" : " (log-only)"),
        ts: new Date().toISOString(),
      });
      if (enforceDup && dupOf) {
        // Skip the judge entirely — a blocked duplicate needs no conflict
        // report, and skipping saves up to timeoutMs of user-facing latency.
        return {
          duplicate: { factId: top.id, body: dupOf.body, score: top.score },
          conflicts: [],
        };
      }
    }
  }

  const pseudo: IndexedDoc = {
    id: "__pending__",
    space,
    project,
    kind,
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

  // Judge only the top few candidates: this runs before write_context returns,
  // so each judge call is user-facing latency (§ write-path budget).
  const cands = supersessionCandidates(
    live,
    pseudo,
    SYNC_CANDIDATE_K,
    SYNC_COSINE_FLOOR,
  ).slice(0, SYNC_JUDGE_LIMIT);
  const hits: ConflictHit[] = [];
  const ts = new Date().toISOString();

  const judgeOne = async (old: IndexedDoc): Promise<void> => {
    const result = await judgePair(gen, { body: entryBody, kind }, old);
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
  };

  // Parallelize the (≤ SYNC_JUDGE_LIMIT) judges — wall clock ≈ slowest judge,
  // not the sum, under the same timeoutMs race.
  const judgeAll = async () => {
    await Promise.all(cands.map((old) => judgeOne(old)));
  };

  // Hard wall-clock bound: if the judge stalls, surface whatever conflicts were
  // found so far rather than making the author wait — the write is already
  // committed, so partial conflict info is strictly better than a slow response.
  if (opts.timeoutMs != null) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.timeoutMs);
    });
    await Promise.race([judgeAll(), deadline]);
    if (timer) clearTimeout(timer);
  } else {
    await judgeAll();
  }
  return { duplicate: null, conflicts: hits };
}

export function formatDuplicateResult(
  dup: DuplicateHit,
  project: string,
): string {
  const snippet =
    dup.body.length > 120 ? `${dup.body.slice(0, 117)}...` : dup.body;
  return (
    `Duplicate — not re-recorded in '${project}'. Already stored as fact ` +
    `${dup.factId}: "${snippet}" (similarity ${dup.score.toFixed(2)}). ` +
    `To intentionally replace it, write again with supersedes: ["${dup.factId}"].`
  );
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
