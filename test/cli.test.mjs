import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// A clean cwd with no .memorylayer-hook.env, so the CLI's self-load finds nothing
// and the routed read hook genuinely fail-opens (the repo root has a real env file).
const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-cli-"));

/** Run the built CLI with args + no config, so the routed hook fail-opens. */
function run(args, client) {
  return execFileSync(process.execPath, [cli, ...args], {
    input: "",
    encoding: "utf8",
    cwd: cleanCwd,
    env: {
      PATH: process.env.PATH ?? "",
      MEMORYLAYER_HOOK_CLIENT: client ?? "",
    },
  });
}

test("`hook <client>` routes to the read hook (fail-open {})", () => {
  assert.equal(run(["hook", "cursor"]).trim(), "{}");
});

test("`stop-review <client>` routes to the Stop hook; the positional arg sets the client", () => {
  // Empty stdin = a fresh turn, so the Stop hook injects the review (it does not
  // call loadConfig, so nothing fails-open here). The cursor-specific
  // followup_message envelope proves both routing and that the arg set the client.
  const out = JSON.parse(run(["stop-review", "cursor"]));
  assert.match(out.followup_message, /write_context/);
});

test("hook subcommand arg sets the client (raw emits nothing)", () => {
  assert.equal(run(["hook", "raw"]), "");
});

test("`init --help` routes to init and exits 0", () => {
  const out = execFileSync(process.execPath, [cli, "init", "--help"], {
    input: "",
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.match(out, /memorylayer init/);
});
