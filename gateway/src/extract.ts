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

export type GenText = (prompt: string) => Promise<string>;

export interface ExtractedFact {
  kind: string;
  tier: "canon" | "normal";
  body: string;
  entities: string[];
}

const VALID_KINDS = new Set([
  "decision",
  "constraint",
  "preference",
  "reference",
  "context",
  "status",
  "question",
]);

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

function coerce(raw: unknown, entry: ParsedEntry): ExtractedFact[] | null {
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
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
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

/**
 * Parse a fact array out of a model completion: strip an optional ```json```
 * fence, then pull the first balanced `[…]` array (dropping any surrounding
 * prose). Genuinely malformed JSON still throws → the caller floors to the
 * whole entry (correct fail-open).
 */
function parseModelJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  return JSON.parse(extractJsonArray(body) ?? body);
}

export async function extractFacts(
  gen: GenText | null,
  entry: ParsedEntry,
): Promise<ExtractedFact[]> {
  if (!gen) return floor(entry);
  let out: string;
  try {
    out = await gen(buildExtractionPrompt(entry));
  } catch (e) {
    // fail-open, but no longer silent: a thrown gen call means the model id
    // or binding is wrong / unavailable — surface it in `wrangler tail`.
    console.warn(
      `[extract] gen threw for ${entry.file}: ${(e as Error).message}`,
    );
    return floor(entry);
  }
  try {
    const coerced = coerce(parseModelJson(out), entry);
    if (coerced) return coerced;
    console.warn(
      `[extract] no valid facts parsed for ${entry.file}; raw head: ${String(
        out,
      ).slice(0, 200)}`,
    );
    return floor(entry);
  } catch (e) {
    console.warn(
      `[extract] parse failed for ${entry.file}: ${(e as Error).message}; raw head: ${String(
        out,
      ).slice(0, 200)}`,
    );
    return floor(entry);
  }
}
