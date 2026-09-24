// Build two blinded judge packets (order 1, order 2 = every pair swapped) + a sealed key.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
const cases = JSON.parse(readFileSync("rubric.json", "utf8")).cases.filter((c) => existsSync(`stripped/${c.id}-cold.md`));
let seed = 20260923;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const CAL = [["check-prod-kv-value", "cold"], ["commit-personal-editor-settings", "wayform"]]; // calibration: plan vs its padded twin
const items = [
  ...cases.map((c) => ({ kind: "real", id: c.id, task: c.task, x: "cold", y: "wayform", flip: rnd() < 0.5 })),
  ...CAL.map(([id, arm]) => ({ kind: "calibration", id, arm, task: cases.find((c) => c.id === id).task, flip: rnd() < 0.5 })),
];
for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
const plan = (it, side) => it.kind === "real"
  ? readFileSync(`stripped/${it.id}-${side}.md`, "utf8")
  : readFileSync(side === "orig" ? `stripped/${it.id}-${it.arm}.md` : `padded/${it.id}-${it.arm}.md`, "utf8");
const key = [];
const JUDGE = readFileSync("JUDGE.md", "utf8");
for (const order of [1, 2]) {
  const dir = `packet-${order}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/cases`, { recursive: true });
  copyFileSync("team-context.md", `${dir}/team-context.md`);
  writeFileSync(`${dir}/JUDGE.md`, JUDGE);
  items.forEach((it, i) => {
    const cid = `C${String(i + 1).padStart(2, "0")}`;
    const [p, q] = it.kind === "real" ? [it.x, it.y] : ["orig", "padded"];
    const aFirst = it.flip !== (order === 2);
    const [A, B] = aFirst ? [p, q] : [q, p];
    writeFileSync(`${dir}/cases/${cid}.md`, `# ${cid}\n\n## Task\n\n${it.task}\n\n---\n\n## Plan A\n\n${plan(it, A)}\n\n---\n\n## Plan B\n\n${plan(it, B)}\n`);
    key.push({ order, cid, kind: it.kind, id: it.id, A, B });
  });
}
writeFileSync("key.json", JSON.stringify(key, null, 1));
console.log(`packets built: ${items.length} cases x 2 orders`);
