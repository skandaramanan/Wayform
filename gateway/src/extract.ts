/**
 * LLM fact extraction (roadmap §3): condense a multi-fact prose ledger entry
 * into atomic, self-contained facts. This is the ONLY new LLM call in Phase B1
 * and it runs off the write hot path (mcp.ts uses ctx.waitUntil).
 *
 * Fail-open is central and non-negotiable: whenever extraction cannot produce
 * a valid non-empty fact set (no model, thrown call, unparseable or
 * schema-invalid output, empty array), we fall back to ONE fact = the whole
 * entry body at `normal` tier — byte-for-byte Phase A behavior, so recall never
 * regresses. The ledger stays the recoverable source of truth: a better prompt
 * later just means a reindex.
 */
import type { ParsedEntry } from "../../src/frontmatter.js";
import { slug } from "../../src/slug.js";

/** Why a text-gen call is made: the gen seam sizes max_tokens and the neuron
 *  reservation from it (a verdict is ~40 tokens, an extraction ~300). */
export interface GenOpts {
  purpose?: "extract" | "judge";
}
export type GenText = (prompt: string, opts?: GenOpts) => Promise<string>;

export interface ExtractedFact {
  kind: string;
  tier: "canon" | "normal";
  body: string;
  entities: string[];
}

/**
 * Bump whenever the extraction prompt, chunking, model, or fact shape changes.
 * Entries indexed under an older version are re-extracted by the cron's retry
 * sweep a few per tick — never by wiping and rebuilding the whole space.
 */
export const EXTRACTOR_VERSION = "2026-09-13.1";

export const FACT_KINDS = [
  "decision",
  "constraint",
  "preference",
  "reference",
  "context",
  "status",
  "question",
] as const;
const VALID_KINDS = new Set<string>(FACT_KINDS);

/** Bounds on writer-supplied facts (write_context `facts`). */
export const MAX_CLIENT_FACTS = 12;
export const MAX_CLIENT_FACT_CHARS = 1000;

export function buildExtractionPrompt(entry: ParsedEntry): string {
  return [
    "You extract atomic planning facts from a single shared-memory entry.",
    "Rules:",
    "- Output ONLY a JSON array; no prose, no code fence required.",
    '- Each element: {"kind", "tier", "body", "entities"}.',
    "- kind ∈ decision|constraint|preference|reference|context|status|question.",
    "- Split the entry into 1–5 self-contained facts, each understandable ALONE.",
    "- Fidelity over fluency: state only what the entry states; do not infer.",
    "- Include the 'because' when the entry gives one.",
    '- tier = "canon" ONLY for standing rules/conventions/environment invariants',
    '  ("always X", "never Y"); status updates are NEVER canon; else "normal".',
    '- entities: short normalized topic tags (e.g. "cursor", "mcp-config").',
    "",
    `Entry type: ${entry.type}`,
    "Entry body:",
    entry.payload,
  ].join("\n");
}

/**
 * Deterministic entity tags for the extraction floor.
 *
 * The LLM path returns `entities: []` when it fails, and an untagged fact is
 * invisible to entityRank — one of the three candidate generators. RRF scores
 * by how many lists a doc appears in, so losing a generator is not a small
 * penalty: on 2026-09-13 the only doc in 425 containing "Mosaic" ranked 16th
 * for a query built from its own rarest terms, because it reached BM25 alone
 * while short tagged facts reached more.
 *
 * Identifier-shaped tokens are the distinctive terms in an engineering corpus
 * and need no model: snake_case, kebab-case, dotted paths, ALLCAPS constants,
 * and backticked spans. Ordered by first appearance and capped, so tags stay
 * few and stable rather than exhaustive.
 */
export function floorEntities(body: string, cap = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const t = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (t.length < 3 || t.length > 40 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const m of body.matchAll(/`([^`\n]{3,40})`/g)) push(m[1]);
  for (const m of body.matchAll(
    /\b[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)+\b/g,
  )) {
    push(m[0]);
  }
  for (const m of body.matchAll(/\b[A-Z]{3,}(?:_[A-Z0-9]+)*\b/g)) push(m[0]);

  // Prose with no identifier-shaped tokens would otherwise return [] and land
  // right back in the bug this function exists to prevent — a fact invisible to
  // entityRank. Fall back to the longest distinct words: length correlates with
  // specificity, so they are the terms a query is most likely to share.
  if (out.length === 0) {
    const words = [
      ...new Set(body.toLowerCase().match(/[a-z][a-z0-9-]{5,}/g) ?? []),
    ];
    words.sort((a, b) => b.length - a.length);
    // Truncate rather than reject: push() drops anything over 40 chars, and a
    // pathological run with no word breaks would otherwise leave us at [] —
    // exactly the state this fallback exists to make impossible.
    for (const w of words.slice(0, cap)) push(w.slice(0, 40));
  }
  // Last resort: a terse fact ("we use D1 not KV") is all short words and would
  // still be untagged. Any token of 3+ chars beats none.
  if (out.length === 0) {
    for (const w of body.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []) {
      push(w.slice(0, 40));
      if (out.length >= cap) break;
    }
  }
  return out.slice(0, cap);
}

/**
 * The Phase A floor: one whole-entry normal fact — but never an untagged one.
 * See floorEntities() for why empty tags are a ranking bug, not a cosmetic gap.
 */
function floor(entry: ParsedEntry): ExtractedFact[] {
  return [
    {
      kind: entry.type,
      tier: "normal",
      body: entry.payload,
      entities: floorEntities(entry.payload),
    },
  ];
}

function coerce(raw: unknown, entry: { type: string }): ExtractedFact[] | null {
  if (!Array.isArray(raw)) return null;
  const facts: ExtractedFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (!body) continue;
    const kind =
      typeof o.kind === "string" && VALID_KINDS.has(o.kind)
        ? o.kind
        : entry.type;
    const tier = o.tier === "canon" ? "canon" : "normal";
    const entities = Array.isArray(o.entities)
      ? [
          ...new Set(
            o.entities
              .filter((e): e is string => typeof e === "string")
              .map((e) => slug(e))
              .filter((e) => e.length > 0),
          ),
        ]
      : [];
    facts.push({ kind, tier, body, entities });
  }
  return facts.length > 0 ? facts : null;
}

/**
 * Extract the FIRST complete top-level JSON array from `text` by bracket-depth
 * scan, ignoring anything before or after it and counting brackets only outside
 * string literals. Instruct models (esp. on entries that themselves contain
 * JSON/quotes) emit the array with a prose preamble AND trailing chatter — the
 * confirmed llama-3.3-70b failure was "valid array, then more text" (JSON.parse
 * "Unexpected non-whitespace character after JSON"). A greedy first-`[`-to-last-
 * `]` regex over-grabs when prose contains stray brackets; depth-scanning stops
 * at the matching close. Returns null when no balanced array exists.
 */
function balancedArrayAt(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Bound on candidate `[` positions tried per completion. */
const MAX_ARRAY_STARTS = 50;

/**
 * Parse a fact array out of a model completion by trying each `[` in turn
 * until a balanced span parses as an array of objects. The array is not
 * reliably the first `[` nor inside the first code fence: on 2026-09-17 a PR
 * summary came back as rambling markdown with a ```bash block and link
 * brackets before the real array, and grabbing the first fence floored it
 * every day. No candidate parses → throws → the caller floors (fail-open).
 */
function parseModelJson(text: string): unknown {
  let tried = 0;
  for (
    let i = text.indexOf("[");
    i !== -1 && tried < MAX_ARRAY_STARTS;
    i = text.indexOf("[", i + 1), tried++
  ) {
    const span = balancedArrayAt(text, i);
    if (!span) continue;
    try {
      const value: unknown = JSON.parse(span);
      if (
        Array.isArray(value) &&
        value.some((x) => x !== null && typeof x === "object")
      ) {
        return value;
      }
    } catch {
      // not this bracket; try the next
    }
  }
  return JSON.parse(text.trim());
}

/**
 * Target size for one extraction call, in characters.
 *
 * Measured 2026-09-13: 181 of 202 entries came back as a SINGLE whole-entry
 * fact, and 57 of those were over 1500 chars — together holding 52% of all
 * corpus text. Those blobs took the floor path (their tags are
 * floorEntities-shaped), i.e. the model failed to return parseable JSON on a
 * long input. Asking for "1-5 facts" from 4000+ characters is the wrong shape
 * of request regardless: a long entry holds far more than five decisions.
 *
 * Chunking bounds every call instead, so a long entry yields many atomic facts
 * rather than one blob. Atomicity is not cosmetic — the injection budget is
 * token-capped, so one 1000-token blob crowds out ~6 real decisions, and a
 * blob holding ten decisions can never have one of them superseded.
 */
const CHUNK_CHARS = 1200;

/**
 * Hard cap on extraction calls per entry.
 *
 * Chunking multiplies neuron cost: a 4333-char entry is 5 chunks, so 5
 * extractions instead of 1. The daily allocation is 9500 neurons at ~100 per
 * call — 95 calls A DAY, account-wide — and it was fully spent on both
 * 2026-09-12 and 2026-09-13. Uncapped, a handful of long writes exhausts the
 * day and everything after silently floors.
 *
 * Beyond the cap the remaining text is floored as one fact. That is a real
 * quality loss, chosen over an invisible one: a floored fact is still TAGGED
 * (floorEntities), so it reaches all three candidate generators rather than
 * being stranded on BM25.
 */
const MAX_CHUNKS_PER_ENTRY = 4;

/**
 * Split on blank lines, packing paragraphs up to CHUNK_CHARS. Paragraph
 * boundaries keep a decision and its "because" together; a hard character cut
 * would strand the reason in a different chunk from the claim.
 */
export function chunkPayload(payload: string, max = CHUNK_CHARS): string[] {
  if (payload.length <= max) return [payload];
  const paras = payload.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = "";
  for (const para of paras) {
    if (buf && buf.length + para.length + 2 > max) {
      out.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) out.push(buf);
  // A single paragraph longer than max still has to be broken somewhere.
  return out.flatMap((c) =>
    c.length <= max * 2
      ? [c]
      : (c.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? [c]),
  );
}

/**
 * Facts for one entry, plus whether the MODEL failed on it. The retry sweep
 * acts on `floored`, so it is true only for failures a later attempt could fix
 * — unparseable output, a thrown call such as an exhausted budget, no model —
 * and never for the deterministic MAX_CHUNKS_PER_ENTRY remainder, which would
 * fail identically on every retry.
 */
export async function extractFactsDetailed(
  gen: GenText | null,
  entry: ParsedEntry,
): Promise<{ facts: ExtractedFact[]; floored: boolean }> {
  // The writer already split it: nothing to extract, nothing to pay.
  const given = clientFacts(entry.facts, entry);
  if (given) return { facts: given, floored: false };
  if (!gen) return { facts: floor(entry), floored: true };

  // Long entries are extracted chunk by chunk: each call stays small enough to
  // return parseable JSON, and a chunk that still fails only floors ITS OWN
  // slice instead of collapsing the whole entry into one untagged blob.
  const chunks = chunkPayload(entry.payload);
  if (chunks.length > 1) {
    const extracted = chunks.slice(0, MAX_CHUNKS_PER_ENTRY);
    // Independent calls, so in parallel: wall time is the slowest chunk.
    const parts = await Promise.all(
      extracted.map((payload) => extractOne(gen, { ...entry, payload })),
    );
    const facts = parts.flatMap((p) => p.facts);
    const rest = chunks.slice(MAX_CHUNKS_PER_ENTRY);
    if (rest.length > 0) {
      console.log(
        JSON.stringify({
          evt: "extract_chunk_cap",
          file: entry.file,
          chunks: chunks.length,
          extracted: extracted.length,
          floored: rest.length,
        }),
      );
      facts.push(...floor({ ...entry, payload: rest.join("\n\n") }));
    }
    // Floored only when EVERY chunk failed. `floored` queues a full retry of
    // the entry, and on 2026-09-14 seven long entries that had already
    // yielded 7-26 facts were queued to re-buy every chunk for one bad slice.
    // ponytail: a single failed chunk stays one floor fact until the entry
    // changes or EXTRACTOR_VERSION bumps; add per-chunk retry state if that
    // measurably hurts recall.
    return { facts, floored: parts.every((p) => p.floored) };
  }
  return extractOne(gen, entry);
}

export async function extractFacts(
  gen: GenText | null,
  entry: ParsedEntry,
): Promise<ExtractedFact[]> {
  return (await extractFactsDetailed(gen, entry)).facts;
}

/**
 * Writer-supplied facts (write_context `facts`, persisted in the entry's
 * frontmatter), validated like model output: malformed items are dropped,
 * over-long bodies rejected, and an untagged fact gets deterministic tags so
 * it still reaches entityRank. Null when nothing usable remains.
 */
export function clientFacts(
  raw: unknown,
  entry: { type: string },
): ExtractedFact[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const facts = (coerce(raw.slice(0, MAX_CLIENT_FACTS), entry) ?? []).filter(
    (f) => f.body.length <= MAX_CLIENT_FACT_CHARS,
  );
  if (facts.length === 0) return null;
  return facts.map((f) =>
    f.entities.length > 0 ? f : { ...f, entities: floorEntities(f.body) },
  );
}

async function extractOne(
  gen: GenText,
  entry: ParsedEntry,
): Promise<{ facts: ExtractedFact[]; floored: boolean }> {
  const floored = () => ({ facts: floor(entry), floored: true });
  let out: string;
  try {
    out = await gen(buildExtractionPrompt(entry), { purpose: "extract" });
  } catch (e) {
    // fail-open, but no longer silent: a thrown gen call means the model id
    // or binding is wrong / unavailable — surface it in `wrangler tail`.
    console.warn(
      `[extract] gen threw for ${entry.file}: ${(e as Error).message}`,
    );
    return floored();
  }
  try {
    const coerced = coerce(parseModelJson(out), entry);
    if (coerced) return { facts: coerced, floored: false };
    console.warn(
      `[extract] no valid facts parsed for ${entry.file}; raw head: ${String(
        out,
      ).slice(0, 200)}`,
    );
    return floored();
  } catch (e) {
    console.warn(
      `[extract] parse failed for ${entry.file}: ${(e as Error).message}; raw head: ${String(
        out,
      ).slice(0, 200)}`,
    );
    return floored();
  }
}
