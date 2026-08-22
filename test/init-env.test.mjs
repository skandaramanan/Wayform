import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHookEnv,
  buildRemoteHookEnv,
  ensureGitignore,
} from "../dist/init-env.js";

test("buildRemoteHookEnv writes gateway URL and omits any token", () => {
  const out = buildRemoteHookEnv({
    gatewayUrl: "https://gw.example.com",
    project: "acme-eng",
    author: "Dana Lee",
    email: "dana@acme.com",
  });
  assert.match(out, /MEMORYLAYER_GATEWAY_URL=https:\/\/gw\.example\.com/);
  assert.doesNotMatch(out, /MEMORYLAYER_GATEWAY_TOKEN/);
  assert.doesNotMatch(out, /mlk_/);
  assert.match(out, /MEMORYLAYER_PROJECT=acme-eng/);
  assert.match(out, /MEMORYLAYER_AUTHOR=Dana Lee/);
  assert.match(out, /MEMORYLAYER_AUTHOR_EMAIL=dana@acme.com/);
  assert.ok(!/CONTEXT_REPO_URL/.test(out), "hosted-only: no local clone URL");
});

test("buildHookEnv emits all four keys", () => {
  const out = buildHookEnv({
    author: "Ada",
    email: "ada@x.io",
    repoUrl: "https://t@github.com/team/mem.git",
    project: "team-app",
  });
  assert.match(out, /^MEMORYLAYER_AUTHOR=Ada$/m);
  assert.match(out, /^MEMORYLAYER_AUTHOR_EMAIL=ada@x.io$/m);
  assert.match(
    out,
    /^CONTEXT_REPO_URL=https:\/\/t@github.com\/team\/mem.git$/m,
  );
  assert.match(out, /^MEMORYLAYER_PROJECT=team-app$/m);
});

test("ensureGitignore appends missing entries once, preserves content", () => {
  const start = "node_modules/\n";
  const once = ensureGitignore(start, [
    ".memorylayer-hook.env",
    ".claude/settings.local.json",
  ]);
  assert.match(once, /node_modules\//);
  assert.match(once, /\.memorylayer-hook\.env/);
  assert.match(once, /\.claude\/settings\.local\.json/);
  const twice = ensureGitignore(once, [".memorylayer-hook.env"]);
  assert.equal(twice.split(".memorylayer-hook.env").length - 1, 1);
});

test("ensureGitignore matches entries even without trailing newline", () => {
  const out = ensureGitignore("node_modules/", [".memorylayer-hook.env"]);
  assert.match(out, /node_modules\/\n/);
  assert.match(out, /\.memorylayer-hook\.env/);
});
