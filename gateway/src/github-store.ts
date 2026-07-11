import {
  serializeEntry,
  parseEntry,
  type ParsedEntry,
  type EntryType,
} from "../../src/frontmatter.js";
import { packToBudget, DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import { slug, fsSafeTimestamp } from "../../src/slug.js";
import { installationToken } from "./github-auth.js";
import type { Env } from "./env.js";
import type { SpaceMember } from "./tenancy.js";

const GH = "https://api.github.com";
/** Workers free plan allows 50 subrequests/request: 1 token + 1 tree + N blobs. */
export const MAX_ENTRY_FETCH = 40;
const COMMIT_SUBJECT_MAX = 72;

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "memorylayer-gateway",
    "x-github-api-version": "2022-11-28",
  };
}

function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Append one entry as its own file via the Contents API (single call = blob +
 * tree + commit + ref update). Same path scheme and serialized bytes as the
 * local store, so local clones of the space repo read gateway entries and
 * vice versa. Timestamp is gateway server time — hosted writes are immune to
 * client clock skew by construction.
 */
export async function writeEntry(
  env: Env,
  member: SpaceMember,
  project: string,
  entry: { type: EntryType; payload: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedEntry> {
  const token = await installationToken(env, member.installationId, fetchImpl);
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID().slice(0, 8);
  const file = `context/${slug(project)}/${slug(member.author)}/${fsSafeTimestamp(timestamp)}-${id}.md`;
  const contents = serializeEntry(
    { author: member.author, type: entry.type, timestamp, id, project },
    entry.payload,
  );
  const subject = entry.payload
    .trim()
    .split("\n")[0]
    .slice(0, COMMIT_SUBJECT_MAX);

  const res = await fetchImpl(
    `${GH}/repos/${member.owner}/${member.repo}/contents/${file}`,
    {
      method: "PUT",
      headers: ghHeaders(token),
      body: JSON.stringify({
        message: `${entry.type}(${slug(project)}): ${subject}`,
        branch: member.branch,
        content: b64encodeUtf8(contents),
        committer: { name: member.author, email: member.authorEmail },
        author: { name: member.author, email: member.authorEmail },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `write failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  return {
    author: member.author,
    type: entry.type,
    timestamp,
    id,
    payload: entry.payload.trim(),
    file,
  };
}

/**
 * Fetch the project's newest entries from GitHub: one recursive Trees call,
 * then the MAX_ENTRY_FETCH newest files (filenames start with the fs-safe ISO
 * timestamp, so lexicographic basename order IS recency order) fetched IN
 * PARALLEL — Workers runs 6 connections concurrently and queues the rest, so
 * this is ~7 GitHub round-trips instead of 40+ sequential ones (~45s → ~8s on
 * a 92-entry space). `total` reflects every entry in the tree, matching the
 * local read contract. Ordering falls back to frontmatter timestamps —
 * gateway-written entries carry server-clock timestamps, so hosted spaces are
 * skew-free; mixed local writes use the same fallback the local comparator has.
 * Returns entries UN-packed so callers can cache once and pack per budget.
 */
async function fetchRecentEntries(
  env: Env,
  member: SpaceMember,
  project: string,
  fetchImpl: typeof fetch,
): Promise<{ entries: ParsedEntry[]; total: number }> {
  const token = await installationToken(env, member.installationId, fetchImpl);
  const prefix = `context/${slug(project)}/`;

  const treeRes = await fetchImpl(
    `${GH}/repos/${member.owner}/${member.repo}/git/trees/${member.branch}?recursive=1`,
    { headers: ghHeaders(token) },
  );
  if (treeRes.status === 404 || treeRes.status === 409)
    return { entries: [], total: 0 };
  if (!treeRes.ok) throw new Error(`tree read failed: ${treeRes.status}`);
  const tree = (await treeRes.json()) as {
    tree: { path: string; type: string }[];
  };

  const paths = tree.tree
    .filter(
      (t) =>
        t.type === "blob" &&
        t.path.startsWith(prefix) &&
        t.path.endsWith(".md"),
    )
    .map((t) => t.path)
    .sort((a, b) => basename(a).localeCompare(basename(b)));

  const total = paths.length;
  const recent = paths.slice(-MAX_ENTRY_FETCH);

  const fetched = await Promise.all(
    recent.map(async (p): Promise<ParsedEntry | null> => {
      const res = await fetchImpl(
        `${GH}/repos/${member.owner}/${member.repo}/contents/${p}?ref=${member.branch}`,
        {
          headers: {
            ...ghHeaders(token),
            accept: "application/vnd.github.raw+json",
          },
        },
      );
      if (!res.ok) return null; // fail-open per entry, matching the local parser's tolerance
      return parseEntry(await res.text(), p);
    }),
  );
  const entries = fetched.filter((e): e is ParsedEntry => e !== null);

  entries.sort((a, b) =>
    a.timestamp === b.timestamp
      ? a.file.localeCompare(b.file)
      : a.timestamp.localeCompare(b.timestamp),
  );
  return { entries, total };
}

/** Recency read: fetch newest entries and pack to the token budget. */
export async function readEntries(
  env: Env,
  member: SpaceMember,
  project: string,
  budgetTokens: number = DEFAULT_BUDGET_TOKENS,
  fetchImpl: typeof fetch = fetch,
): Promise<{ entries: ParsedEntry[]; total: number }> {
  const { entries, total } = await fetchRecentEntries(
    env,
    member,
    project,
    fetchImpl,
  );
  return { entries: packToBudget(entries, budgetTokens), total };
}

/** Seconds a recency read may be served stale (mirrors /hook/read's cache).
 *  Writes through the gateway invalidate immediately; local writers pushing
 *  straight to GitHub are healed by the TTL. */
const RECENCY_CACHE_TTL_SECONDS = 60;

/** Cache key for the per-space+project recency entry cache. write_context
 *  deletes it alongside hookCacheKey. */
export function recencyCacheKey(space: string, project: string): string {
  return `recency:${space}:${slug(project)}`;
}

/**
 * readEntries behind a KV cache. Even parallelized, the GitHub fan-out takes
 * several seconds — over the local CLI's 4s remote-read timeout — so repeat
 * queryless reads must be a single KV hit. The cache stores the UN-packed
 * newest entries; the budget is applied per request, so callers with
 * different budgets share one cache line. KV failures fall through to the
 * direct read (cache is an optimization, never a dependency).
 */
export async function readEntriesCached(
  env: Env,
  member: SpaceMember,
  project: string,
  budgetTokens: number = DEFAULT_BUDGET_TOKENS,
  fetchImpl: typeof fetch = fetch,
): Promise<{ entries: ParsedEntry[]; total: number }> {
  const key = recencyCacheKey(member.space, project);
  try {
    const cached = await env.ROUTING.get(key);
    if (cached !== null) {
      const { entries, total } = JSON.parse(cached) as {
        entries: ParsedEntry[];
        total: number;
      };
      return { entries: packToBudget(entries, budgetTokens), total };
    }
  } catch {
    // unreadable/corrupt cache — fall through to the direct read
  }
  const { entries, total } = await fetchRecentEntries(
    env,
    member,
    project,
    fetchImpl,
  );
  try {
    await env.ROUTING.put(key, JSON.stringify({ entries, total }), {
      expirationTtl: RECENCY_CACHE_TTL_SECONDS,
    });
  } catch {
    // best-effort: a missed put just means the next read fetches again
  }
  return { entries: packToBudget(entries, budgetTokens), total };
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
