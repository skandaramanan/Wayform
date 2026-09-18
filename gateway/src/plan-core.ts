/**
 * The plan object's pure core (docs/PLAN.md Phase 1). A plan is an
 * append-only event log in the git ledger — one file per change under
 * plans/<project>/<planId>/ — and step() is the ONLY place the lifecycle is
 * defined. The live write path and the rebuild replay both go through it, so
 * D1 can never hold a state the ledger cannot reproduce.
 *
 * No I/O here: plan-db.ts projects a PlanStep into D1, plans.ts does the rest.
 */
import { slug, fsSafeTimestamp } from "../../src/slug.js";

export const PLAN_STATES = [
  "draft",
  "active",
  "building",
  "shipped",
  "superseded",
] as const;
export type PlanState = (typeof PLAN_STATES)[number];
export type DecisionRole = "inherited" | "produced" | "violated";

/** States whose body is searchable. Shipping retires the checklist: the
 *  decisions it produced stay, the step-by-step does not. */
export const INDEXED_STATES: ReadonlySet<PlanState> = new Set([
  "draft",
  "active",
  "building",
]);

/** Forward-only. `superseded` is reached only through a supersede event. */
const NEXT: Record<PlanState, PlanState | null> = {
  draft: "active",
  active: "building",
  building: "shipped",
  shipped: null,
  superseded: null,
};

export interface PlanMeta {
  id: string;
  project: string; // slugged
  seq: number;
  title: string;
  repo: string | null;
  branch: string | null;
  author: string;
  state: PlanState;
  version: number;
  rev: number;
  runs: number;
  supersededBy: string | null;
  created: string;
  updated: string;
}

interface EventBase {
  plan: string;
  rev: number;
  author: string;
  ts: string;
}
export type PlanEvent =
  | (EventBase & {
      op: "create";
      project: string;
      seq: number;
      title: string;
      repo?: string;
      branch?: string;
      body: string;
      inherits?: string[];
    })
  | (EventBase & { op: "edit"; title?: string; body?: string })
  | (EventBase & {
      op: "transition";
      to: "active" | "building" | "shipped";
      agent?: string;
      commitSha?: string;
      produced?: string[];
      /** Ledger entry holding the produced decisions. */
      entry?: string;
    })
  | (EventBase & { op: "supersede"; by: string });

export interface PlanBody {
  version: number;
  markdown: string;
  author: string;
  ts: string;
}

export interface PlanStep {
  meta: PlanMeta;
  body?: PlanBody;
  links: { factId: string; role: DecisionRole }[];
  runStart?: { run: number; agent: string; ts: string };
  runEnd?: {
    run: number;
    ts: string;
    outcome: "shipped" | "superseded";
    commitSha: string | null;
  };
}

/** A rejected event. Callers surface the message; nothing was written. */
export class PlanError extends Error {}

export function step(prev: PlanMeta | null, ev: PlanEvent): PlanStep {
  if (ev.op === "create") {
    if (prev) throw new PlanError(`plan ${ev.plan} already exists`);
    if (ev.rev !== 1)
      throw new PlanError(`create must be rev 1, got ${ev.rev}`);
    return {
      meta: {
        id: ev.plan,
        project: slug(ev.project),
        seq: ev.seq,
        title: ev.title,
        repo: ev.repo ?? null,
        branch: ev.branch ?? null,
        author: ev.author,
        state: "draft",
        version: 1,
        rev: 1,
        runs: 0,
        supersededBy: null,
        created: ev.ts,
        updated: ev.ts,
      },
      body: { version: 1, markdown: ev.body, author: ev.author, ts: ev.ts },
      links: (ev.inherits ?? []).map((factId) => ({
        factId,
        role: "inherited" as const,
      })),
    };
  }
  if (!prev) throw new PlanError(`plan ${ev.plan} does not exist`);
  if (ev.rev !== prev.rev + 1)
    throw new PlanError(
      `stale rev ${ev.rev} for plan #${prev.seq} (it is at rev ${prev.rev})`,
    );
  const meta: PlanMeta = { ...prev, rev: ev.rev, updated: ev.ts };
  const out: PlanStep = { meta, links: [] };
  switch (ev.op) {
    case "edit": {
      if (!INDEXED_STATES.has(prev.state))
        throw new PlanError(
          `plan #${prev.seq} is ${prev.state} and frozen — supersede it with a new plan`,
        );
      if (ev.title !== undefined) meta.title = ev.title;
      if (ev.body !== undefined) {
        meta.version = prev.version + 1;
        out.body = {
          version: meta.version,
          markdown: ev.body,
          author: ev.author,
          ts: ev.ts,
        };
      }
      return out;
    }
    case "transition": {
      if (NEXT[prev.state] !== ev.to)
        throw new PlanError(
          `illegal transition ${prev.state} → ${ev.to} for plan #${prev.seq}` +
            (NEXT[prev.state] ? ` (next is ${NEXT[prev.state]})` : ""),
        );
      meta.state = ev.to;
      if (ev.to === "building") {
        meta.runs = prev.runs + 1;
        out.runStart = {
          run: meta.runs,
          agent: ev.agent ?? "unknown",
          ts: ev.ts,
        };
      }
      if (ev.to === "shipped") {
        if (prev.runs > 0)
          out.runEnd = {
            run: prev.runs,
            ts: ev.ts,
            outcome: "shipped",
            commitSha: ev.commitSha ?? null,
          };
        out.links = (ev.produced ?? []).map((factId) => ({
          factId,
          role: "produced" as const,
        }));
      }
      return out;
    }
    case "supersede": {
      if (prev.state === "superseded")
        throw new PlanError(`plan #${prev.seq} is already superseded`);
      if (ev.by === prev.id)
        throw new PlanError("a plan cannot supersede itself");
      meta.state = "superseded";
      meta.supersededBy = ev.by;
      if (prev.state === "building" && prev.runs > 0)
        out.runEnd = {
          run: prev.runs,
          ts: ev.ts,
          outcome: "superseded",
          commitSha: null,
        };
      return out;
    }
  }
}

/**
 * `---\nevent: {json}\n---\n\n<markdown body>`: the body stays readable on
 * GitHub, and one JSON line can never break or close the frontmatter (the
 * same trick as `facts:` in src/frontmatter.ts).
 */
export function serializeEvent(ev: PlanEvent): string {
  const { body, ...rest } = ev as PlanEvent & { body?: string };
  const head = body === undefined ? rest : { ...rest, hasBody: true };
  return `---\nevent: ${JSON.stringify(head)}\n---\n\n${body === undefined ? "" : `${body}\n`}`;
}

export function parseEvent(raw: string): PlanEvent | null {
  const m = raw.match(/^---\nevent: (.*)\n---\n\n([\s\S]*)$/);
  if (!m) return null;
  try {
    const { hasBody, ...ev } = JSON.parse(m[1]) as PlanEvent & {
      hasBody?: boolean;
    };
    if (
      typeof ev.op !== "string" ||
      typeof ev.plan !== "string" ||
      typeof ev.rev !== "number"
    )
      return null;
    return (hasBody ? { ...ev, body: m[2].slice(0, -1) } : ev) as PlanEvent;
  } catch {
    return null;
  }
}

export function planDir(project: string, planId: string): string {
  return `plans/${slug(project)}/${planId}`;
}

/** Zero-padded rev first, so path order IS replay order. */
export function eventPath(ev: PlanEvent, project: string): string {
  const rand = crypto.randomUUID().slice(0, 4);
  return `${planDir(project, ev.plan)}/${String(ev.rev).padStart(5, "0")}-${fsSafeTimestamp(ev.ts)}-${rand}.md`;
}

/**
 * Replay one plan's event files. A raced duplicate rev, an illegal event or
 * an unparseable file is skipped — deterministically, so every rebuild of the
 * same ledger yields the same plan.
 */
export function foldEvents(files: { path: string; raw: string }[]): {
  meta: PlanMeta | null;
  steps: PlanStep[];
  skipped: string[];
} {
  let meta: PlanMeta | null = null;
  const steps: PlanStep[] = [];
  const skipped: string[] = [];
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const ev = parseEvent(f.raw);
    try {
      if (!ev) throw new PlanError("unparseable event");
      const s = step(meta, ev);
      steps.push(s);
      meta = s.meta;
    } catch {
      skipped.push(f.path);
    }
  }
  return { meta, steps, skipped };
}

/** An in-flight plan's searchable doc body. bge embeds ~512 tokens anyway. */
export const PLAN_DOC_CHARS = 4000;

export function planDocBody(meta: PlanMeta, markdown: string): string {
  return `Plan #${meta.seq} [${meta.state}] ${meta.title}\n\n${markdown}`.slice(
    0,
    PLAN_DOC_CHARS,
  );
}
