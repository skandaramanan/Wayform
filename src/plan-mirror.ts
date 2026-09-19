/**
 * Writes the gateway's plan mirror into <root>/.wayform/plans/. The folder
 * git-ignores itself (.wayform/.gitignore = "*"), so the user's repo history,
 * branches and status never see it. Read-only view: edits go through edit_plan.
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { remoteApiPlans, type PlanMirror } from "./remote-read.js";

export function writePlanMirror(root: string, r: PlanMirror | null): void {
  if (r === null) return; // gateway unusable: keep the last good copy
  const base = path.join(root, ".wayform");
  const dir = path.join(base, "plans");
  if (!r.enabled) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(base, ".gitignore"), "*\n");
  const keep = new Set<string>();
  for (const p of r.plans) {
    const file = path.basename(p.file); // traversal guard: server slugs too
    if (!file.endsWith(".md")) continue;
    keep.add(file);
    fs.writeFileSync(path.join(dir, file), `${p.markdown}\n`);
  }
  for (const f of fs.readdirSync(dir))
    if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
}

/** Never rejects: the mirror must not affect the session. */
export async function syncPlanMirror(
  cfg: Pick<Config, "gatewayUrl">,
  project: string,
  root: string,
): Promise<void> {
  try {
    writePlanMirror(root, await remoteApiPlans(cfg, project));
  } catch {
    // fail-open
  }
}
