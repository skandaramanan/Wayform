import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CSRF_COOKIE,
  generateCSRFProtection,
  validateCSRFToken,
  renderConsentPage,
  githubAuthorizeUrl,
} from "../dist/gateway/src/oauth-consent.js";

test("CSRF cookie is __Host- prefixed, HttpOnly, Secure, Path=/, SameSite=Lax", () => {
  const { token, setCookie } = generateCSRFProtection();
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);
  assert.match(setCookie, new RegExp(`^${CSRF_COOKIE}=${token};`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /Domain=/);
});

test("validateCSRFToken accepts a matching form field and cookie", () => {
  const { token, setCookie } = generateCSRFProtection();
  const form = new FormData();
  form.set("csrf_token", token);
  const req = new Request("https://gw.test/authorize", {
    method: "POST",
    headers: { cookie: cookieFromSetCookie(setCookie) },
  });
  const { clearCookie } = validateCSRFToken(form, req);
  assert.match(clearCookie, new RegExp(`^${CSRF_COOKIE}=;`));
  assert.match(clearCookie, /Max-Age=0/);
});

test("validateCSRFToken rejects a missing or mismatched token", () => {
  const { token, setCookie } = generateCSRFProtection();
  const req = new Request("https://gw.test/authorize", {
    method: "POST",
    headers: { cookie: cookieFromSetCookie(setCookie) },
  });
  const empty = new FormData();
  assert.throws(() => validateCSRFToken(empty, req), /CSRF/);
  const wrong = new FormData();
  wrong.set("csrf_token", token + "x");
  assert.throws(() => validateCSRFToken(wrong, req), /CSRF/);
});

test("consent HTML escapes the client name and includes CSRF + authorize controls", () => {
  const html = renderConsentPage({
    clientName: `<script>alert("xss")</script>`,
    csrfToken: "csrf-1",
    state: "state-1",
  });
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /csrf-1/);
  assert.match(html, /state-1/);
  assert.match(html, /Wayform/i);
  assert.match(html, /<button[^>]*type="submit"/);
});

test("githubAuthorizeUrl points at GitHub App user OAuth with callback and state", () => {
  const url = githubAuthorizeUrl({
    clientId: "Iv1.abc",
    redirectUri: "https://gw.test/callback",
    state: "st-1",
  });
  const parsed = new URL(url);
  assert.equal(
    parsed.origin + parsed.pathname,
    "https://github.com/login/oauth/authorize",
  );
  assert.equal(parsed.searchParams.get("client_id"), "Iv1.abc");
  assert.equal(
    parsed.searchParams.get("redirect_uri"),
    "https://gw.test/callback",
  );
  assert.equal(parsed.searchParams.get("state"), "st-1");
});

function cookieFromSetCookie(setCookie) {
  return setCookie.split(";")[0];
}
