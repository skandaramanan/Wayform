/**
 * The entry markdown shape: one source of truth for how an entry is serialized
 * to disk (write path) and parsed back (read path). Keeping both here means the
 * two can never drift into incompatible formats — the same reason the projection
 * lives once in context-format.ts.
 */

export type EntryType = "decision" | "context";

/**
 * One atomic fact the WRITER pre-split. Stored in the entry's frontmatter so
 * every later re-index reuses it instead of paying for server-side LLM
 * extraction again — the writing agent already understood the text.
 */
export interface EntryFact {
  kind: string;
  body: string;
  tier?: string;
  entities?: string[];
}

/** The minimal payload a caller supplies to record an entry. */
export interface WriteEntry {
  author: string;
  type: EntryType;
  payload: string;
}

/** A fully-resolved entry as it exists on disk and comes back from a read. */
export interface ParsedEntry {
  author: string;
  type: EntryType;
  timestamp: string;
  id: string;
  payload: string;
  file: string;
  facts?: EntryFact[];
}

/** The frontmatter block that precedes an entry's body, in serialization order. */
export interface EntryFrontmatter {
  author: string;
  type: EntryType;
  timestamp: string;
  id: string;
  project: string;
  facts?: EntryFact[];
}

/**
 * Render an entry to its on-disk markdown: a frontmatter block followed by the
 * trimmed payload. This is the ONLY place the write format is defined.
 * `facts` is one JSON line — JSON.stringify escapes newlines, so it can never
 * break the line-per-key frontmatter or close the block early.
 */
export function serializeEntry(fm: EntryFrontmatter, payload: string): string {
  return (
    `---\n` +
    `author: ${fm.author}\n` +
    `type: ${fm.type}\n` +
    `timestamp: ${fm.timestamp}\n` +
    `id: ${fm.id}\n` +
    `project: ${fm.project}\n` +
    (fm.facts && fm.facts.length > 0
      ? `facts: ${JSON.stringify(fm.facts)}\n`
      : "") +
    `---\n\n` +
    `${payload.trim()}\n`
  );
}

/** Malformed facts are dropped, never fatal: the payload is still the record. */
function parseFacts(raw: string | undefined): EntryFact[] | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    const facts = value.filter(
      (f): f is EntryFact =>
        !!f &&
        typeof f === "object" &&
        typeof (f as EntryFact).body === "string" &&
        (f as EntryFact).body.trim() !== "",
    );
    return facts.length > 0 ? facts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse an on-disk entry back into a ParsedEntry, or null if it is malformed
 * (no frontmatter, or missing the required author/timestamp). This is the ONLY
 * place the read format is defined.
 */
export function parseEntry(raw: string, file: string): ParsedEntry | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const front = Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => {
        const idx = line.indexOf(":");
        return idx === -1
          ? null
          : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
      .filter((x): x is [string, string] => x !== null),
  );

  if (!front.timestamp || !front.author) return null;
  const facts = parseFacts(front.facts);
  return {
    author: front.author,
    type: (front.type as EntryType) || "context",
    timestamp: front.timestamp,
    id: front.id || "",
    payload: match[2].trim(),
    file,
    ...(facts ? { facts } : {}),
  };
}
