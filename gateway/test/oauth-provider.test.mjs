import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, seedGithubMember } from "./helpers.mjs";

const { default: worker } = await import("../dist/gateway/src/worker.js");

const ctx = { waitUntil() {} };

function fetchGw(path, init = {}, env = makeEnv()) {
  return worker.fetch(new Request(`https://gw.test${path}`, init), env, ctx);
}

test("unauthenticated /mcp is 401 with RFC 9728 WWW-Authenticate", async () => {
  const res = await fetchGw("/mcp", { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  const www = res.headers.get("www-authenticate") ?? "";
  assert.match(www, /Bearer/);
  assert.match(
    www,
    /resource_metadata="https:\/\/gw.test\/.well-known\/oauth-protected-resource\/mcp"/,
  );
});

test("one /mcp OAuth grant reaches every protected member route", async () => {
  const env = makeEnv();
  await seedGithubMember(env, {
    space: "team-a",
    installationId: 7,
    owner: "acme",
    repo: "memory",
    author: "Ada",
    authorEmail: "1+ada@users.noreply.github.com",
    githubId: 1,
    githubLogin: "ada",
    role: "admin",
  });
  const accessToken = await issueAccessToken(env, {
    githubId: 1,
    githubLogin: "ada",
  });
  const authorization = `Bearer ${accessToken}`;

  const ping = await fetchGw(
    "/mcp",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    },
    env,
  );
  assert.equal(ping.status, 200);

  const hookRead = await fetchGw(
    "/mcp/hook/read",
    { headers: { authorization } },
    env,
  );
  assert.equal(hookRead.status, 400);
  assert.equal(await hookRead.text(), "missing project");

  const hookPrompt = await fetchGw(
    "/mcp/hook/prompt",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: "{}",
    },
    env,
  );
  assert.equal(hookPrompt.status, 200);
  assert.equal(await hookPrompt.text(), "");

  const apiRead = await fetchGw(
    "/mcp/api/read",
    { headers: { authorization } },
    env,
  );
  assert.equal(apiRead.status, 400);
  assert.equal(await apiRead.text(), "missing project");
});

test("unauthenticated hook and api read routes are 401 with resource_metadata", async () => {
  for (const [path, init] of [
    ["/mcp/hook/read?project=p", {}],
    ["/mcp/hook/prompt", { method: "POST", body: "{}" }],
    ["/mcp/api/read?project=p", {}],
  ]) {
    const res = await fetchGw(path, init);
    assert.equal(res.status, 401, path);
    assert.match(
      res.headers.get("www-authenticate") ?? "",
      /resource_metadata=/,
      path,
    );
  }
});

test("legacy member routes identify their canonical replacements", async () => {
  for (const [path, replacement, method] of [
    ["/hook/read", "/mcp/hook/read", "GET"],
    ["/hook/prompt", "/mcp/hook/prompt", "POST"],
    ["/api/read", "/mcp/api/read", "GET"],
  ]) {
    const res = await fetchGw(path, { method });
    assert.equal(res.status, 410, path);
    assert.match(await res.text(), new RegExp(replacement));
    assert.equal(res.headers.get("www-authenticate"), null);
  }
});

test("GET /.well-known/oauth-protected-resource/mcp is RFC 9728 metadata", async () => {
  const res = await fetchGw("/.well-known/oauth-protected-resource/mcp");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resource, "https://gw.test/mcp");
  assert.ok(Array.isArray(body.authorization_servers));
  assert.ok(body.authorization_servers.includes("https://gw.test"));
  assert.ok(body.bearer_methods_supported.includes("header"));
});

test("authorization server metadata advertises PKCE S256, DCR, and CIMD", async () => {
  const res = await fetchGw("/.well-known/oauth-authorization-server");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.issuer, "https://gw.test");
  assert.equal(body.authorization_endpoint, "https://gw.test/authorize");
  assert.equal(body.token_endpoint, "https://gw.test/oauth/token");
  assert.equal(body.registration_endpoint, "https://gw.test/oauth/register");
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.equal(body.client_id_metadata_document_supported, true);
});

test("POST /oauth/register dynamically registers a public PKCE client", async () => {
  const res = await fetchGw("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Cursor",
      redirect_uris: ["http://127.0.0.1:9876/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.client_id);
  assert.equal(body.token_endpoint_auth_method, "none");
});

test("GET /authorize shows a consent page after DCR, with a __Host- CSRF cookie", async () => {
  const env = makeEnv();
  const client = await registerClient(env);
  const res = await fetchGw(await authorizePath(client.client_id), {}, env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Wayform/i);
  assert.match(html, /Cursor/);
  assert.match(html, /csrf_token/);
  const csrf = res.headers.get("set-cookie") ?? "";
  assert.match(csrf, /__Host-CSRF_TOKEN=/);
  assert.match(csrf, /HttpOnly/);
  assert.match(csrf, /Secure/);
  assert.doesNotMatch(csrf, /Domain=/);
});

test("POST /authorize without CSRF is rejected; with CSRF redirects to GitHub", async () => {
  const env = makeEnv();
  const client = await registerClient(env);
  const shown = await fetchGw(await authorizePath(client.client_id), {}, env);
  const html = await shown.text();
  const csrfCookie = (shown.headers.get("set-cookie") ?? "")
    .split(",")
    .map((c) => c.trim())
    .find((c) => c.startsWith("__Host-CSRF_TOKEN="));
  assert.ok(csrfCookie);
  const csrfToken = csrfCookie.split(";")[0].split("=")[1];
  const state = html.match(/name="state"\s+value="([^"]+)"/)?.[1];
  assert.ok(state);

  const denied = await fetchGw(
    "/authorize",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        state,
      }).toString(),
    },
    env,
  );
  assert.ok(denied.status >= 400);

  const approved = await fetchGw(
    "/authorize",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `__Host-CSRF_TOKEN=${csrfToken}`,
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        state,
      }).toString(),
    },
    env,
  );
  assert.equal(approved.status, 302);
  const location = approved.headers.get("location") ?? "";
  assert.match(location, /^https:\/\/github.com\/login\/oauth\/authorize/);
  assert.match(location, /client_id=Iv1\.testoauth/);
  const setCookie = approved.headers.getSetCookie?.() ?? [
    approved.headers.get("set-cookie") ?? "",
  ];
  assert.ok(setCookie.some((c) => c.includes("__Host-CONSENTED_STATE=")));
});

test("an mlk_ bearer on the Worker HTTP gate is still a provider 401", async () => {
  const res = await fetchGw("/mcp", {
    method: "POST",
    headers: { authorization: "Bearer mlk_not-an-oauth-token" },
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("health, webhook, admin, and setup stay outside the member OAuth plane", async () => {
  const env = makeEnv(undefined, { WEBHOOK_SECRET: "whsec" });
  const health = await fetchGw("/health", {}, env);
  assert.equal(health.status, 200);

  const webhook = await fetchGw(
    "/webhook/github",
    {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=dead" },
      body: "{}",
    },
    env,
  );
  assert.equal(webhook.status, 401);
  assert.equal(await webhook.text(), "bad signature");
  assert.equal(webhook.headers.get("www-authenticate"), null);

  const admin = await fetchGw("/admin/installations", {}, env);
  assert.equal(admin.status, 403);
  assert.equal(admin.headers.get("www-authenticate"), null);

  const installCallback = await fetchGw("/install/callback", {}, env);
  assert.equal(installCallback.status, 400);
  assert.equal(installCallback.headers.get("www-authenticate"), null);
  const installSelect = await fetchGw("/install/select", {}, env);
  assert.equal(installSelect.status, 405);
  assert.equal(installSelect.headers.get("www-authenticate"), null);
});

async function registerClient(env) {
  const res = await fetchGw(
    "/oauth/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Cursor",
        redirect_uris: ["http://127.0.0.1:9876/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    },
    env,
  );
  assert.equal(res.status, 201);
  return res.json();
}

async function issueAccessToken(env, props) {
  const client = await registerClient(env);
  const verifier = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = Buffer.from(digest).toString("base64url");
  await fetchGw("/health", {}, env);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: {
      responseType: "code",
      clientId: client.client_id,
      redirectUri: "http://127.0.0.1:9876/callback",
      scope: ["mcp"],
      state: "client-state",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource: "https://gw.test/mcp",
    },
    userId: String(props.githubId),
    metadata: { githubLogin: props.githubLogin },
    scope: ["mcp"],
    props,
  });
  const code = new URL(redirectTo).searchParams.get("code");
  assert.ok(code);
  const token = await fetchGw(
    "/oauth/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:9876/callback",
        code,
        code_verifier: verifier,
        resource: "https://gw.test/mcp",
      }),
    },
    env,
  );
  assert.equal(token.status, 200);
  return (await token.json()).access_token;
}

async function pkceChallenge() {
  const verifier = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}

async function authorizePath(clientId) {
  const challenge = await pkceChallenge();
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:9876/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: "https://gw.test/mcp",
  });
  return `/authorize?${q}`;
}
