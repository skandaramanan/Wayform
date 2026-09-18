/**
 * Plan service (docs/PLAN.md Phase 1): the one layer MCP tools — and later
 * the desktop app — call. Every mutation is validate → commit one event file
 * to the git ledger → project it into D1. The ledger is the source of truth;
 * D1 is rebuilt from it (rebuildPlan/rebuildPlans) whenever the two could
 * disagree.
 */
import type { Env, HandlerCtx } from "./env.js";
import type { SpaceMember } from "./tenancy.js";
import type { SpaceRepo } from "./ingest.js";
import type { D1Like, IndexDb } from "./index-db.js";
import type { Embedder } from "./retrieval.js";
import { installationToken } from "./github-auth.js";
import { clientFacts, type GenText } from "./extract.js";
import { ingestEntries } from "./ingest.js";
import { indexDeps } from "./deps.js";
import { afterEntryWritten, fetchOf, type Caller } from "./memory.js";
import type { ParsedEntry } from "../../src/frontmatter.js";
import {
  listLedgerDir,
  listLedgerTree,
  putLedgerFile,
  readLedgerFile,
  writeEntry,
} from "./github-store.js";
import {
  eventPath,
  foldEvents,
  INDEXED_STATES,
  planDir,
  planDocBody,
  PlanError,
  serializeEvent,
  step,
  type DecisionRole,
  type PlanBody,
  type PlanEvent,
  type PlanMeta,
  type PlanStep,
} from "./plan-core.js";
import {
  applyStep,
  bumpCounter,
  clearPlan,
  getBody,
  getPlan,
  listLinks,
  listPlans,
  listRuns,
  nextSeq,
  type PlanRun,
} from "./plan-db.js";
import { slug } from "../../src/slug.js";

export const MAX_TITLE_CHARS = 200;
/** Ledger files are one Contents PUT; D1 rows cap at 1MB. 60k chars is a
 *  very long plan and far inside both. */
export const MAX_PLAN_BODY_CHARS = 60_000;
export const MAX_LINKED_FACTS = 50;

export interface PlanCtx {
  env: Env;
  member: SpaceMember;
  db: D1Like;
  idx: IndexDb | null;
  embed: Embedder | null;
  /** Only the ship path's supersession judging uses it; null skips judging. */
  gen?: GenText | null;
  fetchImpl: typeof fetch;
  /** waitUntil for post-response cache work; absent = run inline. */
  ctx?: HandlerCtx;
}

/** The plan context for a caller, from the gateway's bindings. */
export function planCtx(c: Caller): PlanCtx {
  if (!c.env.DB) throw new PlanError("plans are not enabled on this gateway");
  const deps = indexDeps(c.env);
  return {
    env: c.env,
    member: c.member,
    db: c.env.DB,
    idx: deps?.db ?? null,
    embed: deps?.embed ?? null,
    gen: deps?.gen ?? null,
    fetchImpl: fetchOf(c.env),
    ctx: c.ctx,
  };
}

export interface PlanLinkView {
  factId: string;
  role: DecisionRole;
  /** null = the fact no longer exists (content ids dangle, never lie). */
  body: string | null;
  supersededBy: string | null;
}

export interface PlanView {
  meta: PlanMeta;
  body: PlanBody;
  links: PlanLinkView[];
  runs: PlanRun[];
}

/** A leading letter: getPlan reads an all-digit ref as #seq, and ~2% of
 *  bare 8-hex ids are all digits. */
function newPlanId(): string {
  return `p${crypto.randomUUID().replace(/-/g, "").slice(0, 7)}`;
}

function cleanTitle(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t || t.length > MAX_TITLE_CHARS)
    throw new PlanError(`title must be 1-${MAX_TITLE_CHARS} characters`);
  return t;
}

function cleanBody(raw: unknown): string {
  const b = typeof raw === "string" ? raw.trim() : "";
  if (!b || b.length > MAX_PLAN_BODY_CHARS)
    throw new PlanError(`body must be 1-${MAX_PLAN_BODY_CHARS} characters`);
  return b;
}

export function cleanIds(raw: unknown, what: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PlanError(`${what} must be a list of ids`);
  const ids = [
    ...new Set(
      raw
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length > MAX_LINKED_FACTS)
    throw new PlanError(`at most ${MAX_LINKED_FACTS} ${what}`);
  return ids;
}

async function mustGet(
  c: PlanCtx,
  project: string,
  ref: string,
): Promise<PlanMeta> {
  const m = await getPlan(c.db, c.member.space, project, ref);
  if (!m) throw new PlanError(`plan ${ref} not found in project "${project}"`);
  return m;
}

/**
 * The single write path. step() rejects before anything is written; the
 * ledger commit comes before D1, so D1 never holds what the ledger lacks.
 * Losing the rev race means the ledger now holds both events — replay
 * decides, and the caller is told to re-read.
 */
async function mutate(
  c: PlanCtx,
  project: string,
  prev: PlanMeta | null,
  ev: PlanEvent,
): Promise<PlanStep> {
  const s = step(prev, ev);
  const what = ev.op === "transition" ? `→ ${ev.to}` : ev.op;
  await putLedgerFile(
    c.env,
    c.member,
    eventPath(ev, project),
    serializeEvent(ev),
    `plan(${slug(project)}): #${s.meta.seq} ${what} — ${s.meta.title}`.slice(
      0,
      120,
    ),
    c.fetchImpl,
  );
  if (!(await applyStep(c.db, c.member.space, prev?.rev ?? null, s))) {
    await rebuildPlan(c, project, s.meta.id);
    throw new PlanError(
      `plan #${s.meta.seq} changed concurrently — re-read it and retry`,
    );
  }
  const markdown =
    s.body?.markdown ??
    (await getBody(c.db, c.member.space, s.meta.id))?.markdown ??
    "";
  await syncPlanDoc(c.idx, c.embed, c.member.space, s.meta, markdown);
  return s;
}

/** The docs kind of an in-flight plan's searchable body. */
export const PLAN_KIND = "plan";

/**
 * The split-on-shipped rule, on the retrieval side: a draft/active/building
 * plan is ONE docs row (`plan:<id>`) so search finds work in flight; in any
 * other state that row is deleted, so plan #500 never retrieves 499 retired
 * checklists. Ingest never indexes plans/ (projectFromPath is context/-only),
 * so this is the only way a plan body reaches the index. Supersession, the
 * dup gate and the guard skip kind=plan: a checklist is not a decision.
 */
export async function syncPlanDoc(
  idx: IndexDb | null,
  embed: Embedder | null,
  space: string,
  meta: PlanMeta,
  markdown: string,
): Promise<void> {
  if (!idx) return;
  const sourceId = `plan:${meta.id}`;
  if (!INDEXED_STATES.has(meta.state)) {
    await idx.replaceBySource(space, sourceId, []);
    return;
  }
  const body = planDocBody(meta, markdown);
  let embedding: number[] = [];
  try {
    embedding = embed ? ((await embed([body]))[0] ?? []) : [];
  } catch {
    // fail-open: BM25 still finds it; the next edit re-embeds
  }
  await idx.replaceBySource(space, sourceId, [
    {
      id: sourceId,
      space,
      project: meta.project,
      kind: PLAN_KIND,
      tier: "normal",
      body,
      sourceFile: planDir(meta.project, meta.id),
      sourceAuthor: meta.author,
      sourceTs: meta.updated,
      embedding,
      supersededBy: null,
      createdAt: new Date().toISOString(),
      sourceId,
      entities: [],
    },
  ]);
}

function eventBase(c: PlanCtx, plan: string, rev: number) {
  return { plan, rev, author: c.member.author, ts: new Date().toISOString() };
}

export async function readPlan(
  c: PlanCtx,
  project: string,
  ref: string,
  version?: number,
): Promise<PlanView> {
  const meta = await mustGet(c, project, ref);
  const body = await getBody(c.db, c.member.space, meta.id, version);
  if (!body)
    throw new PlanError(
      `plan #${meta.seq} has no version ${version} (latest is v${meta.version})`,
    );
  const links = await Promise.all(
    (await listLinks(c.db, c.member.space, meta.id)).map(async (l) => {
      const d = c.idx ? await c.idx.getDoc(c.member.space, l.factId) : null;
      return {
        ...l,
        body: d?.body ?? null,
        supersededBy: d?.supersededBy ?? null,
      };
    }),
  );
  return {
    meta,
    body,
    links,
    runs: await listRuns(c.db, c.member.space, meta.id),
  };
}

export function listProjectPlans(
  c: PlanCtx,
  project: string,
): Promise<PlanMeta[]> {
  return listPlans(c.db, c.member.space, project);
}

export async function createPlan(
  c: PlanCtx,
  project: string,
  a: {
    title: unknown;
    body: unknown;
    repo?: unknown;
    branch?: unknown;
    inherits?: unknown;
  },
): Promise<PlanView & { unknownInherits: string[] }> {
  const title = cleanTitle(a.title);
  const body = cleanBody(a.body);
  const known: string[] = [];
  const unknown: string[] = [];
  for (const id of cleanIds(a.inherits, "inherits")) {
    const d = c.idx ? await c.idx.getDoc(c.member.space, id) : null;
    (d ? known : unknown).push(id);
  }
  const opt = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined;
  const repo = opt(a.repo);
  const branch = opt(a.branch);
  const id = newPlanId();
  await mutate(c, project, null, {
    ...eventBase(c, id, 1),
    op: "create",
    project: slug(project),
    seq: await nextSeq(c.db, c.member.space, project),
    title,
    body,
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(known.length ? { inherits: known } : {}),
  } as PlanEvent);
  return {
    ...(await readPlan(c, project, id)),
    unknownInherits: unknown,
  };
}

export async function editPlan(
  c: PlanCtx,
  project: string,
  ref: string,
  a: { title?: unknown; body?: unknown },
): Promise<PlanView> {
  if (a.title === undefined && a.body === undefined)
    throw new PlanError("an edit needs a new title or body");
  const title = a.title === undefined ? undefined : cleanTitle(a.title);
  const body = a.body === undefined ? undefined : cleanBody(a.body);
  const prev = await mustGet(c, project, ref);
  await mutate(c, project, prev, {
    ...eventBase(c, prev.id, prev.rev + 1),
    op: "edit",
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  return readPlan(c, project, prev.id);
}

const TARGETS = ["active", "building", "shipped", "superseded"] as const;
type Target = (typeof TARGETS)[number];

function short(raw: unknown, max: number): string | undefined {
  return typeof raw === "string" && raw.trim()
    ? raw.trim().slice(0, max)
    : undefined;
}

/**
 * Move a plan along its lifecycle. Shipping SPLITS the plan: the decisions it
 * produced are written as a normal writer-split ledger entry (zero LLM
 * extraction), ingested inline so their fact ids exist, and linked as
 * `produced`; the checklist leaves search (see syncPlanDoc). Superseding
 * points the plan at its successor and logs the edge in supersession_log; the
 * old plan's produced facts are NOT touched — a replaced plan does not make
 * its decisions stale; `supersedes` on the successor's ship does that.
 */
export async function transitionPlan(
  c: PlanCtx,
  project: string,
  ref: string,
  a: {
    to: unknown;
    agent?: unknown;
    commitSha?: unknown;
    decisions?: unknown;
    producedFactIds?: unknown;
    supersedes?: unknown;
    supersededBy?: unknown;
  },
): Promise<
  PlanView & { entry?: ParsedEntry & { digest: string }; warning?: string }
> {
  const to = a.to as Target;
  if (!TARGETS.includes(to))
    throw new PlanError(`to must be one of: ${TARGETS.join(", ")}`);
  const shipping = to === "shipped";
  if (
    !shipping &&
    (a.decisions !== undefined ||
      a.producedFactIds !== undefined ||
      a.supersedes !== undefined)
  )
    throw new PlanError(
      "decisions, produced_fact_ids and supersedes apply only when shipping",
    );
  const prev = await mustGet(c, project, ref);
  const space = c.member.space;

  if (to === "superseded") {
    const byRef = short(a.supersededBy, 40);
    if (!byRef)
      throw new PlanError(
        "superseding needs superseded_by: the replacing plan",
      );
    const by = await mustGet(c, project, byRef);
    if (by.id === prev.id)
      throw new PlanError("a plan cannot supersede itself");
    if (by.state === "superseded")
      throw new PlanError(
        `plan #${by.seq} is itself superseded — point at its successor`,
      );
    await mutate(c, project, prev, {
      ...eventBase(c, prev.id, prev.rev + 1),
      op: "supersede",
      by: by.id,
    });
    if (c.idx) {
      await c.idx
        .logSupersession({
          space,
          project: prev.project,
          newFactId: `plan:${by.id}`,
          oldFactId: `plan:${prev.id}`,
          verdict: "replaces",
          autoLinked: true,
          reason: "plan-supersedes",
          ts: new Date().toISOString(),
        })
        .catch(() => {});
    }
    return readPlan(c, project, prev.id);
  }

  const ev: PlanEvent = {
    ...eventBase(c, prev.id, prev.rev + 1),
    op: "transition",
    to,
    ...(to === "building" ? { agent: short(a.agent, 100) ?? "unknown" } : {}),
    ...(shipping && short(a.commitSha, 64)
      ? { commitSha: short(a.commitSha, 64) }
      : {}),
  };
  // Dry run: an illegal transition fails before the decisions entry is
  // written, so a rejected ship leaves nothing behind anywhere.
  step(prev, ev);
  if (!shipping) {
    await mutate(c, project, prev, ev);
    return readPlan(c, project, prev.id);
  }

  const facts =
    a.decisions === undefined || a.decisions === null
      ? null
      : clientFacts(a.decisions, { type: "decision" });
  if (a.decisions != null && !facts)
    throw new PlanError(
      "decisions must be a list of { body, kind?, entities? } facts",
    );
  const supersedes = cleanIds(a.supersedes, "supersedes");
  const known: string[] = [];
  const unknown: string[] = [];
  for (const id of cleanIds(a.producedFactIds, "produced_fact_ids")) {
    const d = c.idx ? await c.idx.getDoc(space, id) : null;
    (d ? known : unknown).push(id);
  }

  let entry: (ParsedEntry & { digest: string }) | undefined;
  const produced = [...known];
  if (facts) {
    entry = await writeEntry(
      c.env,
      c.member,
      project,
      {
        type: "decision",
        payload:
          `Decisions produced by plan #${prev.seq}: ${prev.title}\n\n` +
          facts.map((f) => `- ${f.body}`).join("\n"),
        facts,
      },
      c.fetchImpl,
    );
    if (c.idx) {
      await ingestEntries(
        c.idx,
        c.embed,
        c.gen ?? null,
        space,
        project,
        [entry],
        { authorSupersedes: supersedes },
      );
      produced.unshift(
        ...(await c.idx.docsBySource(space, entry.id)).map((d) => d.id),
      );
    }
    await afterEntryWritten(c, project, entry);
  }
  await mutate(c, project, prev, {
    ...ev,
    ...(produced.length ? { produced } : {}),
    ...(entry ? { entry: entry.id } : {}),
  });
  const warnings = [
    ...(produced.length === 0
      ? [
          "Shipped with no decisions recorded — pass `decisions` so what this plan settled reaches the team's memory.",
        ]
      : []),
    ...(unknown.length
      ? [`Not linked (no such fact): ${unknown.join(", ")}.`]
      : []),
  ];
  return {
    ...(await readPlan(c, project, prev.id)),
    ...(entry ? { entry } : {}),
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

/** Replace one plan's D1 rows with the replay of its ledger events. */
async function projectFiles(
  db: D1Like,
  idx: IndexDb | null,
  embed: Embedder | null,
  space: string,
  planId: string,
  files: { path: string; raw: string }[],
): Promise<PlanMeta | null> {
  const { meta, steps, skipped } = foldEvents(files);
  if (skipped.length > 0)
    console.log(
      JSON.stringify({ evt: "plan_replay_skipped", space, planId, skipped }),
    );
  await clearPlan(db, space, planId);
  let prevRev: number | null = null;
  for (const s of steps) {
    await applyStep(db, space, prevRev, s);
    prevRev = s.meta.rev;
  }
  if (meta) {
    await bumpCounter(db, space, meta.project, meta.seq);
    const body = [...steps].reverse().find((x) => x.body)?.body;
    await syncPlanDoc(idx, embed, space, meta, body?.markdown ?? "");
  }
  return meta;
}

export async function rebuildPlan(
  c: PlanCtx,
  project: string,
  planId: string,
): Promise<PlanMeta | null> {
  const token = await installationToken(
    c.env,
    c.member.installationId,
    c.fetchImpl,
  );
  const paths = await listLedgerDir(
    c.env,
    c.member,
    planDir(project, planId),
    c.fetchImpl,
    token,
  );
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      raw:
        (await readLedgerFile(c.env, c.member, path, c.fetchImpl, token)) ?? "",
    })),
  );
  return projectFiles(c.db, c.idx, c.embed, c.member.space, planId, files);
}

/**
 * Rebuild every plan in a space from the ledger, `limit` plans per call.
 * ponytail: one GitHub read per event file; page with offset/limit when a
 * space's plan history outgrows one request's subrequest budget.
 */
export async function rebuildPlans(
  env: Env,
  db: D1Like,
  idx: IndexDb | null,
  embed: Embedder | null,
  sr: SpaceRepo,
  fetchImpl: typeof fetch,
  opts: { offset?: number; limit?: number } = {},
): Promise<{ rebuilt: number; total: number; nextOffset: number | null }> {
  const token = await installationToken(env, sr.installationId, fetchImpl);
  const byPlan = new Map<string, string[]>();
  for (const p of await listLedgerTree(env, sr, "plans/", fetchImpl, token)) {
    const m = p.match(/^(plans\/[^/]+\/[^/]+)\/[^/]+\.md$/);
    if (!m) continue;
    byPlan.set(m[1], [...(byPlan.get(m[1]) ?? []), p]);
  }
  const dirs = [...byPlan.keys()].sort();
  const offset = opts.offset ?? 0;
  const page =
    opts.limit != null
      ? dirs.slice(offset, offset + opts.limit)
      : dirs.slice(offset);
  for (const dir of page) {
    const files = await Promise.all(
      byPlan.get(dir)!.map(async (path) => ({
        path,
        raw: (await readLedgerFile(env, sr, path, fetchImpl, token)) ?? "",
      })),
    );
    await projectFiles(db, idx, embed, sr.space, dir.split("/")[2], files);
  }
  const end = offset + page.length;
  return {
    rebuilt: page.length,
    total: dirs.length,
    nextOffset: end < dirs.length ? end : null,
  };
}

const day = (iso: string) => iso.slice(0, 10);

export function renderPlanList(project: string, plans: PlanMeta[]): string {
  if (plans.length === 0)
    return `No plans in project "${project}" yet — create one with create_plan.`;
  return (
    `# Plans in project "${project}" (newest first)\n\n` +
    plans
      .map(
        (p) =>
          `- #${p.seq} [${p.state}] ${p.title} — v${p.version}, updated ${day(p.updated)} _(id: ${p.id})_`,
      )
      .join("\n")
  );
}

export function renderPlan(v: PlanView): string {
  const m = v.meta;
  const where = m.repo ? ` · ${m.repo}${m.branch ? `@${m.branch}` : ""}` : "";
  const lines = [
    `# Plan #${m.seq} — ${m.title}`,
    "",
    `state: ${m.state} · v${v.body.version} of ${m.version}` +
      (v.body.version < m.version ? " (older version)" : "") +
      `${where} · by ${m.author} · updated ${day(m.updated)} · id ${m.id}`,
  ];
  if (m.supersededBy) lines.push(`superseded by plan ${m.supersededBy}`);
  if (v.links.length > 0) {
    lines.push("", `## Decisions (${v.links.length})`, "");
    for (const l of v.links) {
      const note =
        l.body === null
          ? " ⚠ fact no longer exists"
          : l.supersededBy
            ? ` ⚠ superseded by ${l.supersededBy}`
            : "";
      const text = l.body === null ? "" : ` ${l.body.slice(0, 200)}`;
      lines.push(`- [${l.role}]${text} _(id: ${l.factId})_${note}`);
    }
  }
  if (v.runs.length > 0) {
    lines.push("", "## Runs", "");
    for (const r of v.runs)
      lines.push(
        `- run ${r.run} · ${r.agent} · ${r.started}` +
          (r.ended ? ` → ${r.ended} · ${r.outcome}` : " · open") +
          (r.commitSha ? ` · ${r.commitSha}` : ""),
      );
  }
  lines.push("", "---", "", v.body.markdown);
  return lines.join("\n");
}

export function formatCreated(
  v: PlanView & { unknownInherits: string[] },
): string {
  return (
    `Created plan #${v.meta.seq} "${v.meta.title}" (id ${v.meta.id}, draft, v1)` +
    (v.links.length ? ` inheriting ${v.links.length} decision(s).` : ".") +
    (v.unknownInherits.length
      ? ` Not linked (no such fact): ${v.unknownInherits.join(", ")}.`
      : "")
  );
}

export function formatEdited(v: PlanView): string {
  return `Plan #${v.meta.seq} "${v.meta.title}" is now v${v.meta.version}.`;
}

export function formatTransitioned(v: PlanView & { warning?: string }): string {
  const produced = v.links.filter((l) => l.role === "produced");
  return (
    `Plan #${v.meta.seq} "${v.meta.title}" is now ${v.meta.state}.` +
    (produced.length
      ? ` Produced decisions: ${produced.map((l) => l.factId).join(", ")}.`
      : "") +
    (v.warning ? ` ${v.warning}` : "")
  );
}
