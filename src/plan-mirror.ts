/**
 * Writes the gateway's plan mirror into <root>/.wayform/plans/. The folder
 * git-ignores itself (.wayform/.gitignore = "*"), so the user's repo history,
 * branches and status never see it. Read-only view: edits go through edit_plan.
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { remoteApiPlans, type PlanMirror } from "./remote-read.js";

// Only files this mirror itself writes ever get pruned — anything else in
// plans/ (a stray note, someone's own file) is left alone.
const MIRROR_FILE = /^\d+-[a-z0-9-]+\.md$/;

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false; // doesn't exist yet — nothing to guard against
  }
}

export function writePlanMirror(root: string, r: PlanMirror | null): void {
  if (r === null) return; // gateway unusable: keep the last good copy
  const base = path.join(root, ".wayform");
  const dir = path.join(base, "plans");
  // Symlink escape guard: .wayform or .wayform/plans replaced with a symlink
  // must not make mkdir/write/readdir/prune operate on whatever it points
  // at. Bail out entirely rather than follow it.
  if (isSymlink(base) || isSymlink(dir)) return;
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
    if (MIRROR_FILE.test(f) && !keep.has(f))
      fs.rmSync(path.join(dir, f), { force: true });
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
