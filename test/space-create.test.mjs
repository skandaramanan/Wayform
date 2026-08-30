import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpaceCreateArgs, runSpaceCreate } from "../dist/space-create.js";

test("parseSpaceCreateArgs reads owner and defaults the production App slug", () => {
  const parsed = parseSpaceCreateArgs(["--owner", "spear-ai"]);
  assert.equal(parsed.owner, "spear-ai");
  assert.equal(parsed.appSlug, "memorylayer-gateway");
  assert.match(parsed.gatewayUrl, /workers\.dev$/);
});

test("runSpaceCreate prints the guided onboarding sequence, never a credential", async () => {
  const logs = [];
  await runSpaceCreate(["--owner", "dberquist"], {
    log: (m) => logs.push(m),
  });
  const out = logs.join("\n");
  assert.match(out, /allowlist/i);
  assert.match(out, /dberquist/);
  assert.match(out, /github.com\/apps\/memorylayer-gateway/);
  assert.match(out, /wayform init --remote/);
  assert.match(out, /Connect/i);
  assert.match(out, /\/mcp/);
  assert.doesNotMatch(out, /installations\/new/);
  assert.doesNotMatch(out, /mlk_/);
  assert.doesNotMatch(out, /wfi_/);
  assert.doesNotMatch(out, /ADMIN_SECRET=[^$\n]/);
});
