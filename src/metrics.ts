import fs from "node:fs/promises";
import path from "node:path";
import { slug } from "./store.js";
import type { Config } from "./config.js";

/**
 * Metrics instrumentation. Appends one JSON line per context read/write to a
 * per-author append log in the shared context repo, so the 4-week reliance test
 * is measurable. This module is vendor-NEUTRAL: the `source` tag is `hook`/`mcp`,
 * never a client name.
 *
 * FAIL-OPEN is load-bearing: a metric that breaks or slows a read/write would
 * poison the exact signal it exists to measure, so every error is swallowed.
 * This is a pure local append — no git, no network. Reads never flush; the next
 * write commits accumulated lines via ContextStore.flushMetrics().
 */
export type MetricSource = "hook" | "mcp";
export type MetricEvent = "read" | "write";

export interface MetricRecord {
  source: MetricSource;
  event: MetricEvent;
  project: string;
  /** Reads only: entry count returned by store.read. Ignored on writes. */
  total?: number;
}

/** Repo-relative path of an author's append log: `metrics/<slug(author)>.jsonl`. */
export function metricsRelPath(author: string): string {
  return path.join("metrics", `${slug(author)}.jsonl`);
}

export async function recordMetric(
  cfg: Config,
  rec: MetricRecord,
): Promise<void> {
  try {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        author: cfg.author,
        source: rec.source,
        event: rec.event,
        project: rec.project,
        // total is reads-only to avoid overloading one field with two types.
        ...(rec.event === "read" && rec.total !== undefined
          ? { total: rec.total }
          : {}),
      }) + "\n";
    const abs = path.join(cfg.repoPath, metricsRelPath(cfg.author));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, line, "utf8");
  } catch {
    // Fail-open: never break or slow a read/write. A lost metric is invisible;
    // a throwing metric would poison the signal it measures.
  }
}
