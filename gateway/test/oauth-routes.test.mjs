import { test } from "node:test";
import assert from "node:assert/strict";
import { API_ROUTES } from "../dist/gateway/src/oauth.js";

const covered = (path) =>
  API_ROUTES.some((r) => path === r || path.startsWith(r + "/"));

/**
 * Guards two bugs that reached production on 2026-09-13.
 *
 * 1. apiRoute was "/mcp" only while the admin handlers checked identity, so the
 *    provider supplied no ctx.props and every operator request 403'd.
 * 2. Adding "/admin" to apiRoute then produced 401 "Invalid audience": the
 *    provider matches a token's audience against the REQUEST PATH, and tokens
 *    are minted with resource "<origin>/mcp", so nothing outside /mcp can ever
 *    present a valid one.
 *
 * The rest of the gateway suite cannot catch either — those tests inject
 * env.oauthProps as a seam and never run the provider.
 */
test("every identity-gated path sits under an OAuth API route", () => {
  const adminPaths = [
    "/mcp/admin/installations",
    "/mcp/admin/product-repos",
    "/mcp/admin/allowlist",
    "/mcp/admin/reindex",
    "/mcp/admin/supersession-audit",
    "/mcp/admin/clear-supersession",
    "/mcp/admin/golden-candidate",
    "/mcp/admin/retrieval-log",
  ];
  for (const path of [...adminPaths, "/mcp", "/mcp/hook/read"]) {
    assert.ok(
      covered(path),
      `${path} is not under any API_ROUTE, so the provider gives it no ` +
        `ctx.props and identity checks on it reject every caller`,
    );
  }
});

test("no identity-gated path escapes the audience prefix tokens are minted for", () => {
  // A token's audience is "<origin>/mcp". audienceMatches requires the request
  // path to equal that path or start with it + "/", so an admin route outside
  // /mcp is unreachable by any token we issue.
  assert.ok(
    !covered("/admin/installations"),
    "the pre-2026-09-13 path must NOT be treated as covered",
  );
});
