import { test } from "node:test";
import assert from "node:assert/strict";
import { API_ROUTES } from "../dist/gateway/src/oauth.js";

/**
 * Guards a bug that reached production: apiRoute was "/mcp" only, so the OAuth
 * provider never populated ctx.props for /admin/*, and every operator request
 * 403'd on an undefined githubId.
 *
 * The rest of the gateway suite cannot catch this — those tests inject
 * env.oauthProps as a seam and never run the provider — so this asserts the
 * wiring the seam hides.
 */
test("every identity-gated prefix is declared as an OAuth API route", () => {
  for (const prefix of ["/mcp", "/admin"]) {
    assert.ok(
      API_ROUTES.includes(prefix),
      `${prefix} must be in API_ROUTES; without it the provider supplies no ` +
        `ctx.props and every identity check on that prefix rejects all callers`,
    );
  }
});

test("API_ROUTES are path prefixes, not full URLs", () => {
  for (const route of API_ROUTES) {
    assert.match(route, /^\/[a-z]/, `${route} should be a leading-slash path`);
  }
});
