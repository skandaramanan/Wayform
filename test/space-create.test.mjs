import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSpaceCreateArgs,
  runSpaceCreate,
} from "../dist/space-create.js";

test("parseSpaceCreateArgs reads owner and defaults the production App slug", () => {
  const parsed = parseSpaceCreateArgs(["--owner", "spear-ai"]);
  assert.equal(parsed.owner, "spear-ai");
  assert.equal(parsed.appSlug, "memorylayer-gateway");
  assert.match(parsed.gatewayUrl, /workers\.dev$/);
});

test("runSpaceCreate prints the install URL and MCP URL, never a token", async () => {
  const logs = [];
  await runSpaceCreate(["--owner", "dberquist"], {
    log: (m) => logs.push(m),
  });
  const out = logs.join("\n");
  assert.match(out, /allowlist/i);
  assert.match(out, /dberquist/);
  assert.match(out, /github.com\/apps\/memorylayer-gateway/);
  assert.match(out, /\/mcp/);
  assert.doesNotMatch(out, /mlk_/);
  assert.doesNotMatch(out, /wfi_/);
  assert.doesNotMatch(out, /ADMIN_SECRET=[^$\n]/);
});
