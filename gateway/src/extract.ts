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

/** The Phase A floor: one whole-entry normal fact. */
function floor(entry: ParsedEntry): ExtractedFact[] {
  return [{ kind: entry.type, tier: "normal", body: entry.payload, entities: [] }];
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
      typeof o.kind === "string" && VALID_KINDS.has(o.kind) ? o.kind : entry.type;
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

/** Strip an optional ```json ... ``` fence, then JSON.parse. */
function parseModelJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  return JSON.parse(body);
}

export async function extractFacts(
  gen: GenText | null,
  entry: ParsedEntry,
): Promise<ExtractedFact[]> {
  if (!gen) return floor(entry);
  try {
    const out = await gen(buildExtractionPrompt(entry));
    const coerced = coerce(parseModelJson(out), entry);
    return coerced ?? floor(entry);
  } catch {
    return floor(entry);
  }
}
