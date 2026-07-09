import fs from "node:fs/promises";
import path from "node:path";
import { slug } from "./store.js";
/** Repo-relative path of an author's append log: `metrics/<slug(author)>.jsonl`. */
export function metricsRelPath(author) {
    return path.join("metrics", `${slug(author)}.jsonl`);
}
export async function recordMetric(cfg, rec) {
    // Gateway-only members have no local clone to append metrics to; their reads
    // are logged server-side (retrieval_log). No-op instead of writing a stray
    // metrics/ file into the member's project cwd. (recordMetric is fail-open.)
    if (!cfg.repoPath)
        return;
    try {
        const line = JSON.stringify({
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
    }
    catch {
        // Fail-open: never break or slow a read/write. A lost metric is invisible;
        // a throwing metric would poison the signal it measures.
    }
}
//# sourceMappingURL=metrics.js.map