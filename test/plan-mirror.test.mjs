import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePlanMirror } from "../dist/plan-mirror.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wf-mirror-"));
const dir = (r) => path.join(r, ".wayform", "plans");

test("enabled: writes plans, self-ignores, prunes stale files", () => {
  const r = tmp();
  writePlanMirror(r, {
    enabled: true,
    plans: [
      { file: "1-a.md", markdown: "# A" },
      { file: "2-b.md", markdown: "# B" },
    ],
  });
  assert.equal(
    fs.readFileSync(path.join(r, ".wayform", ".gitignore"), "utf8"),
    "*\n",
  );
  writePlanMirror(r, {
    enabled: true,
    plans: [{ file: "1-a.md", markdown: "# A v2" }],
  });
  assert.deepEqual(fs.readdirSync(dir(r)).sort(), ["1-a.md"]);
  assert.equal(
    fs.readFileSync(path.join(dir(r), "1-a.md"), "utf8"),
    "# A v2\n",
  );
});

test("disabled removes the folder; null (gateway down) leaves it alone", () => {
  const r = tmp();
  writePlanMirror(r, {
    enabled: true,
    plans: [{ file: "1-a.md", markdown: "# A" }],
  });
  writePlanMirror(r, null);
  assert.ok(fs.existsSync(dir(r)));
  writePlanMirror(r, { enabled: false, plans: [] });
  assert.ok(!fs.existsSync(dir(r)));
});

test("a hostile filename cannot escape the plans dir", () => {
  const r = tmp();
  writePlanMirror(r, {
    enabled: true,
    plans: [{ file: "../../evil.md", markdown: "x" }],
  });
  assert.ok(!fs.existsSync(path.join(r, "evil.md")));
  assert.ok(!fs.existsSync(path.join(r, ".wayform", "evil.md")));
});

test("a symlinked plans dir is not followed — target is left alone", () => {
  const r = tmp();
  const victim = tmp();
  fs.writeFileSync(path.join(victim, "secret.md"), "victim data");
  fs.mkdirSync(path.join(r, ".wayform"), { recursive: true });
  fs.symlinkSync(victim, dir(r));
  writePlanMirror(r, {
    enabled: true,
    plans: [{ file: "1-a.md", markdown: "# A" }],
  });
  assert.equal(
    fs.readFileSync(path.join(victim, "secret.md"), "utf8"),
    "victim data",
  );
  assert.ok(!fs.existsSync(path.join(victim, "1-a.md")));
});

test("a symlinked .wayform dir is not followed — no gitignore leaks into target", () => {
  const r = tmp();
  const victim = tmp();
  fs.writeFileSync(path.join(victim, "secret.md"), "victim data");
  fs.symlinkSync(victim, path.join(r, ".wayform"));
  writePlanMirror(r, {
    enabled: true,
    plans: [{ file: "1-a.md", markdown: "# A" }],
  });
  assert.equal(
    fs.readFileSync(path.join(victim, "secret.md"), "utf8"),
    "victim data",
  );
  assert.ok(!fs.existsSync(path.join(victim, ".gitignore")));
  assert.ok(!fs.existsSync(path.join(victim, "plans")));
});

test("a stray non-matching file in plans/ survives a sync", () => {
  const r = tmp();
  writePlanMirror(r, {
    enabled: true,
    plans: [{ file: "1-a.md", markdown: "# A" }],
  });
  fs.writeFileSync(path.join(dir(r), "notes.txt"), "keep me");
  writePlanMirror(r, {
    enabled: true,
    plans: [{ file: "1-a.md", markdown: "# A v2" }],
  });
  assert.ok(fs.existsSync(path.join(dir(r), "notes.txt")));
});
