import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeEnv, ghFetch, seedGithubMember } from "./helpers.mjs";
import { DAILY_NEURON_BUDGET } from "../dist/gateway/src/neuron-budget.js";

const { default: worker } = await import("../dist/gateway/src/worker.js");
const ctx = { waitUntil() {} };

function fetchGw(path, init = {}, env = makeEnv()) {
  return worker.fetch(new Request(`https://gw.test${path}`, init), env, ctx);
}

test("consumeOAuthState returns stored request once, then null", async () => {
  const {
    createOAuthState,
    consumeOAuthState,
  } = await import("../dist/gateway/src/oauth-consent.js");
  const env = makeEnv();
  const { stateToken } = await createOAuthState(
    { clientId: "c1", scope: ["mcp"] },
    env.OAUTH_KV,
  );
  const first = await consumeOAuthState(env.OAUTH_KV, stateToken);
  assert.deepEqual(first, { clientId: "c1", scope: ["mcp"] });
  assert.equal(await consumeOAuthState(env.OAUTH_KV, stateToken), null);
});

test("validateConsentedState accepts the hashed __Host-CONSENTED_STATE cookie", async () => {
  const {
    bindStateToSession,
    validateConsentedState,
  } = await import("../dist/gateway/src/oauth-consent.js");
  const { setCookie } = await bindStateToSession("state-token-1");
  const cookie = setCookie.split(";")[0];
  await validateConsentedState(
    new Request("https://gw.test/callback?state=state-token-1", {
      headers: { cookie },
    }),
    "state-token-1",
  );
  await assert.rejects(
    validateConsentedState(
      new Request("https://gw.test/callback?state=state-token-1"),
      "state-token-1",
    ),
    /consent/i,
  );
});

test("preview HTML is a design-partner page, not an allowlist form", async () => {
  const { renderPreviewPage } = await import(
    "../dist/gateway/src/oauth-consent.js"
  );
  const html = renderPreviewPage();
  assert.match(html, /design-partner preview/i);
  assert.doesNotMatch(html, /allowlist/i);
});

test("allowlist matches logins case-insensitively and * opens signup", async () => {
  const { allowlistMatches, addToAllowlist, isAllowlisted } = await import(
    "../dist/gateway/src/spaces.js"
  );
  assert.equal(allowlistMatches(["Ada", "spear-ai"], "ada"), true);
  assert.equal(allowlistMatches(["spear-ai"], "dberquist"), false);
  assert.equal(allowlistMatches(["*"], "anyone"), true);
  const env = makeEnv();
  assert.equal(await isAllowlisted(env, "ada"), false);
  await addToAllowlist(env, ["Ada"]);
  assert.equal(await isAllowlisted(env, "ada"), true);
});

test("activateInstallation creates a plan=pilot space only when the owner is allowlisted", async () => {
  const { activateInstallation, getSpaceByInstallation } = await import(
    "../dist/gateway/src/spaces.js"
  );
  const env = makeEnv();
  const input = {
    installationId: 42,
    owner: "ada",
    repo: "memory",
    actorGithubId: 101,
    actorLogin: "ada",
  };
  assert.equal(await activateInstallation(env, input), "preview");
  assert.equal(await getSpaceByInstallation(env, 42), null);

  await env.ROUTING.put("signup:allowlist", JSON.stringify(["ada"]));
  assert.equal(await activateInstallation(env, input), "active");
  const space = await getSpaceByInstallation(env, 42);
  assert.equal(space.plan, "pilot");
  assert.equal(space.createdByGithubId, 101);
  assert.equal(space.status, "active");
  assert.equal(space.space, "ada-memory");
});

test("resolveMember loads the github_id member from ctx.props, not an mlk_ hash", async () => {
  const { resolveMember } = await import("../dist/gateway/src/tenancy.js");
  const env = makeEnv();
  await seedGithubMember(env, {
    space: "ada-memory",
    installationId: 42,
    owner: "ada",
    repo: "memory",
    author: "ada",
    authorEmail: "101+ada@users.noreply.github.com",
    githubId: 101,
    githubLogin: "ada",
    role: "admin",
  });
  const member = await resolveMember(
    new Request("https://gw.test/mcp"),
    env,
    { waitUntil() {}, props: { githubId: 101, githubLogin: "ada" } },
  );
  assert.equal(member.author, "ada");
  assert.equal(member.githubId, 101);
  assert.equal(
    await resolveMember(new Request("https://gw.test/mcp"), makeEnv()),
    null,
  );
});

test("installation.created webhook provisions an allowlisted space and skips others", async () => {
  const { handleWebhook } = await import("../dist/gateway/src/webhook.js");
  const { getSpaceByInstallation } = await import(
    "../dist/gateway/src/spaces.js"
  );
  const SECRET = "hooksecret";
  const sign = (body) =>
    "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  const payload = {
    action: "created",
    installation: {
      id: 99,
      account: { login: "spear-ai", id: 7, type: "Organization" },
    },
    repositories: [
      { name: "team-memory", full_name: "spear-ai/team-memory", private: true },
    ],
    sender: { login: "dberquist", id: 55 },
  };
  const body = JSON.stringify(payload);
  const req = new Request("https://gw/webhook/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": "installation",
    },
    body,
  });

  const blocked = makeEnv(undefined, { WEBHOOK_SECRET: SECRET });
  assert.equal((await handleWebhook(req.clone(), blocked)).status, 200);
  assert.equal(await getSpaceByInstallation(blocked, 99), null);

  const env = makeEnv(undefined, { WEBHOOK_SECRET: SECRET });
  await env.ROUTING.put("signup:allowlist", JSON.stringify(["spear-ai"]));
  assert.equal((await handleWebhook(req, env)).status, 200);
  const space = await getSpaceByInstallation(env, 99);
  assert.equal(space.owner, "spear-ai");
  assert.equal(space.repo, "team-memory");
  assert.equal(space.plan, "pilot");
  const admin = JSON.parse(await env.ROUTING.get("member:github:55"));
  assert.equal(admin.role, "admin");
  assert.equal(admin.githubLogin, "dberquist");
});

test("a GitHub-username invite is not a bearer credential and lets that user join", async () => {
  const { inviteGithubUser, getGithubInvite, placeGithubUser } = await import(
    "../dist/gateway/src/spaces.js"
  );
  const env = makeEnv();
  await seedGithubMember(env, {
    space: "acme-mem",
    installationId: 7,
    owner: "acme",
    repo: "mem",
    author: "ada",
    authorEmail: "a@x.io",
    githubId: 1,
    githubLogin: "ada",
    role: "admin",
  });
  await inviteGithubUser(env, "bo", {
    space: "acme-mem",
    installationId: 7,
    owner: "acme",
    repo: "mem",
    branch: "main",
    invitedByGithubId: 1,
  });
  const invite = await getGithubInvite(env, "Bo");
  assert.equal(invite.space, "acme-mem");
  assert.equal(invite.invite, undefined);
  assert.doesNotMatch(JSON.stringify(invite), /wfi_|mlk_/);

  const placed = await placeGithubUser(
    env,
    { id: 2, login: "bo" },
    [],
  );
  assert.equal(placed.kind, "member");
  assert.equal(placed.member.space, "acme-mem");
  assert.equal(placed.member.role, "member");
  assert.equal(placed.member.githubId, 2);
});

test("org installation access auto-joins without a personal allowlist entry", async () => {
  const { placeGithubUser } = await import("../dist/gateway/src/spaces.js");
  const env = makeEnv();
  await seedGithubMember(env, {
    space: "acme-mem",
    installationId: 7,
    owner: "acme",
    repo: "mem",
    author: "ada",
    authorEmail: "a@x.io",
    githubId: 1,
    githubLogin: "ada",
    role: "admin",
    createdByGithubId: 1,
  });
  const placed = await placeGithubUser(
    env,
    { id: 9, login: "casey" },
    [
      {
        id: 7,
        account: { login: "acme", id: 80, type: "Organization" },
      },
    ],
  );
  assert.equal(placed.kind, "member");
  assert.equal(placed.member.role, "member");
  assert.equal(placed.member.author, "casey");
});

test("account-wide neuron cap is unchanged by space activation", () => {
  assert.equal(DAILY_NEURON_BUDGET, 9500);
});

test("GitHub callback completes MCP authorization for an allowlisted installer", async () => {
  const env = makeEnv(
    ghFetch(
      [],
      [
        [
          "/login/oauth/access_token",
          () => Response.json({ access_token: "ghu_test" }),
        ],
        [
          "/user/installations/42/repositories",
          () =>
            Response.json({
              repositories: [
                {
                  name: "mem",
                  full_name: "ada/mem",
                  owner: { login: "ada" },
                  private: true,
                },
              ],
            }),
        ],
        [
          "/user/installations",
          () =>
            Response.json({
              installations: [
                {
                  id: 42,
                  account: { login: "ada", id: 101, type: "User" },
                },
              ],
            }),
        ],
        [
          "https://api.github.com/user",
          () => Response.json({ id: 101, login: "ada", email: null }),
        ],
      ],
    ),
  );
  await env.ROUTING.put("signup:allowlist", JSON.stringify(["ada"]));
  const client = await registerClient(env);
  const shown = await fetchGw(await authorizePath(client.client_id), {}, env);
  const html = await shown.text();
  const csrfCookie = cookieNamed(shown, "__Host-CSRF_TOKEN");
  const csrfToken = csrfCookie.split("=")[1];
  const state = html.match(/name="state"\s+value="([^"]+)"/)?.[1];
  const approved = await fetchGw(
    "/authorize",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookie,
      },
      body: new URLSearchParams({ csrf_token: csrfToken, state }).toString(),
    },
    env,
  );
  assert.equal(approved.status, 302);
  const ghUrl = new URL(approved.headers.get("location"));
  const stateToken = ghUrl.searchParams.get("state");
  const consented = cookieNamed(approved, "__Host-CONSENTED_STATE");
  const callback = await fetchGw(
    `/callback?code=gh-code&state=${stateToken}`,
    { headers: { cookie: consented } },
    env,
  );
  assert.equal(callback.status, 302);
  const redirect = callback.headers.get("location") ?? "";
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:9876\/callback/);
  assert.match(redirect, /code=/);
});

test("GitHub callback shows the preview page when the installer is not allowlisted", async () => {
  const env = makeEnv(
    ghFetch(
      [],
      [
        [
          "/login/oauth/access_token",
          () => Response.json({ access_token: "ghu_test" }),
        ],
        [
          "/user/installations/1/repositories",
          () =>
            Response.json({
              repositories: [
                {
                  name: "x",
                  full_name: "rando/x",
                  owner: { login: "rando" },
                  private: true,
                },
              ],
            }),
        ],
        [
          "/user/installations",
          () =>
            Response.json({
              installations: [
                {
                  id: 1,
                  account: { login: "rando", id: 9, type: "User" },
                },
              ],
            }),
        ],
        [
          "https://api.github.com/user",
          () => Response.json({ id: 9, login: "rando" }),
        ],
      ],
    ),
  );
  const client = await registerClient(env);
  const shown = await fetchGw(await authorizePath(client.client_id), {}, env);
  const html = await shown.text();
  const csrfCookie = cookieNamed(shown, "__Host-CSRF_TOKEN");
  const csrfToken = csrfCookie.split("=")[1];
  const state = html.match(/name="state"\s+value="([^"]+)"/)?.[1];
  const approved = await fetchGw(
    "/authorize",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookie,
      },
      body: new URLSearchParams({ csrf_token: csrfToken, state }).toString(),
    },
    env,
  );
  const ghUrl = new URL(approved.headers.get("location"));
  const callback = await fetchGw(
    `/callback?code=gh-code&state=${ghUrl.searchParams.get("state")}`,
    { headers: { cookie: cookieNamed(approved, "__Host-CONSENTED_STATE") } },
    env,
  );
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /design-partner preview/i);
});

test("two GitHub users share a space without any mlk_ credential", async () => {
  const { inviteGithubUser, placeGithubUser, getMemberByGithubId } =
    await import("../dist/gateway/src/spaces.js");
  const { resolveMember } = await import("../dist/gateway/src/tenancy.js");
  const env = makeEnv();
  await env.ROUTING.put("signup:allowlist", JSON.stringify(["ada"]));
  const first = await placeGithubUser(
    env,
    { id: 101, login: "ada" },
    [
      {
        id: 42,
        account: { login: "ada", id: 101, type: "User" },
      },
    ],
    async () => [{ owner: "ada", repo: "mem" }],
  );
  assert.equal(first.kind, "member");
  assert.equal(first.member.role, "admin");
  await inviteGithubUser(env, "qitaoshi", {
    space: first.member.space,
    installationId: 42,
    owner: "ada",
    repo: "mem",
    branch: "main",
    invitedByGithubId: 101,
  });
  const second = await placeGithubUser(env, { id: 202, login: "qitaoshi" }, []);
  assert.equal(second.kind, "member");
  assert.equal(second.member.space, first.member.space);
  const ada = await resolveMember(new Request("https://gw.test/mcp"), env, {
    props: { githubId: 101 },
  });
  const qitao = await resolveMember(new Request("https://gw.test/mcp"), env, {
    props: { githubId: 202 },
  });
  assert.equal(ada.space, qitao.space);
  assert.equal((await getMemberByGithubId(env, 202)).role, "member");
  for (const key of env.ROUTING.map.keys()) {
    assert.doesNotMatch(key, /^member:[0-9a-f]{64}$/);
    assert.doesNotMatch(key, /^invite:[0-9a-f]{64}$/);
  }
});

function cookieNamed(res, name) {
  const all = res.headers.getSetCookie?.() ?? [
    res.headers.get("set-cookie") ?? "",
  ];
  const hit = all
    .flatMap((h) => String(h).split(","))
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  assert.ok(hit, `missing cookie ${name}`);
  return hit.split(";")[0];
}

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

async function authorizePath(clientId) {
  const verifier = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = Buffer.from(digest).toString("base64url");
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
