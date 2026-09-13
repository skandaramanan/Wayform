import {
  serializeEntry,
  parseEntry,
  type ParsedEntry,
  type EntryType,
  type EntryFact,
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
/** GitHub blips (observed live 2026-07-20: API partial outage → 503 on the
 *  Contents PUT) must not lose a write — the entry has no other durable home
 *  at this point. Retry 5xx only; 4xx are deterministic. */
const WRITE_RETRY_DELAYS_MS = [500, 1500];

export async function writeEntry(
  env: Env,
  member: SpaceMember,
  project: string,
  entry: { type: EntryType; payload: string; facts?: EntryFact[] },
  fetchImpl: typeof fetch = fetch,
  retryDelaysMs: number[] = WRITE_RETRY_DELAYS_MS,
): Promise<ParsedEntry & { digest: string }> {
  const token = await installationToken(env, member.installationId, fetchImpl);
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID().slice(0, 8);
  const file = `context/${slug(project)}/${slug(member.author)}/${fsSafeTimestamp(timestamp)}-${id}.md`;
  const contents = serializeEntry(
    {
      author: member.author,
      type: entry.type,
      timestamp,
      id,
      project,
      facts: entry.facts,
    },
    entry.payload,
  );
  const subject = entry.payload
    .trim()
    .split("\n")[0]
    .slice(0, COMMIT_SUBJECT_MAX);

  const put = () =>
    fetchImpl(`${GH}/repos/${member.owner}/${member.repo}/contents/${file}`, {
      method: "PUT",
      headers: ghHeaders(token),
      body: JSON.stringify({
        message: `${entry.type}(${slug(project)}): ${subject}`,
        branch: member.branch,
        content: b64encodeUtf8(contents),
        committer: { name: member.author, email: member.authorEmail },
        author: { name: member.author, email: member.authorEmail },
      }),
    });

  let res = await put();
  for (const delay of retryDelaysMs) {
    if (res.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    res = await put();
  }
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
    ...(entry.facts && entry.facts.length > 0 ? { facts: entry.facts } : {}),
    digest: await gitBlobSha(contents),
  };
}

/**
 * Git's blob id for `content` — the same sha the Trees API reports per path —
 * so an entry written here, fetched by a webhook, or listed in a tree has one
 * digest, and ingest can tell "already indexed" without fetching the file.
 */
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const hash = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
 *  Gateway writes warm this key immediately (see warmRecencyCache); external
 *  GitHub pushes are healed by the TTL / webhook. */
export const RECENCY_CACHE_TTL_SECONDS = 300;

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

/**
 * Keep the queryless recency KV line warm so the next read_context never pays
 * the GitHub blob fan-out. Prefer merging `newest` into an existing cache line;
 * if cold, seed with [newest] immediately and optionally refresh from GitHub in
 * the background via the returned promise (callers attach waitUntil).
 */
export async function warmRecencyCache(
  env: Env,
  member: SpaceMember,
  project: string,
  newest?: ParsedEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refresh: Promise<void> }> {
  const key = recencyCacheKey(member.space, project);
  let seeded = false;
  try {
    const cached = await env.ROUTING.get(key);
    let entries: ParsedEntry[] = [];
    let total = 0;
    if (cached !== null) {
      ({ entries, total } = JSON.parse(cached) as {
        entries: ParsedEntry[];
        total: number;
      });
    } else if (newest) {
      entries = [newest];
      total = 1;
      seeded = true;
    }
    if (newest && !entries.some((e) => e.file === newest.file)) {
      entries = [newest, ...entries].slice(0, MAX_ENTRY_FETCH);
      total = Math.max(total, entries.length);
    }
    if (entries.length > 0) {
      await env.ROUTING.put(key, JSON.stringify({ entries, total }), {
        expirationTtl: RECENCY_CACHE_TTL_SECONDS,
      });
    }
  } catch {
    // best-effort
  }

  const refresh = (async () => {
    // Always refresh after a seed (incomplete list) or when no newest was
    // provided (webhook / external push). Skip when we only prepended onto a
    // warm line — next write or TTL will keep it honest enough.
    if (!seeded && newest) return;
    try {
      const { entries, total } = await fetchRecentEntries(
        env,
        member,
        project,
        fetchImpl,
      );
      // Never clobber a seeded/pre-warmed line with an empty GitHub miss.
      if (entries.length === 0 && newest) return;
      await env.ROUTING.put(key, JSON.stringify({ entries, total }), {
        expirationTtl: RECENCY_CACHE_TTL_SECONDS,
      });
    } catch {
      // leave whatever we seeded
    }
  })();

  return { refresh };
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
