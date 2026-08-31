import { test } from "node:test";
import assert from "node:assert/strict";
import { ghFetch, makeEnv } from "./helpers.mjs";

const OAUTH_REQUEST = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "http://127.0.0.1:9876/callback",
  scope: ["mcp"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: "https://gw.test/mcp",
  issuer: "https://gw.test",
};
const USER = { id: 101, login: "ada", email: null };

function cookieNamed(response, name) {
  const all = response.headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie") ?? "",
  ];
  const hit = all
    .flatMap((header) => String(header).split(","))
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(hit, `missing cookie ${name}`);
  return hit.split(";")[0];
}

test("begin setup stores no GitHub credential and offers App installation", async () => {
  const { beginInstallSetup, SETUP_COOKIE } =
    await import("../dist/gateway/src/setup.js");
  const env = makeEnv(undefined, { GITHUB_APP_SLUG: "wayform-test" });
  const response = await beginInstallSetup(
    new Request("https://gw.test/callback"),
    env,
    { oauthRequest: OAUTH_REQUEST, user: USER },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /github\.com\/apps\/wayform-test\/installations\/new/);
  const handle = new URL(
    html.match(/href="(https:\/\/[^"]+)"/)?.[1].replaceAll("&amp;", "&"),
  ).searchParams.get("state");
  assert.ok(handle);
  const stored = await env.OAUTH_KV.get(`oauth:setup:${handle}`);
  assert.equal(JSON.parse(stored).user.login, "ada");
  assert.deepEqual(JSON.parse(stored).oauthRequest, OAUTH_REQUEST);
  assert.doesNotMatch(stored, /ghu_|access_token|githubToken/i);

  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, new RegExp(`^${SETUP_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=600/);
});

test("install callback rejects a missing or mismatched setup cookie", async () => {
  const { beginInstallSetup, handleInstallCallback } =
    await import("../dist/gateway/src/setup.js");
  const env = makeEnv(undefined, { GITHUB_APP_SLUG: "wayform-test" });
  const started = await beginInstallSetup(
    new Request("https://gw.test/callback"),
    env,
    { oauthRequest: OAUTH_REQUEST, user: USER },
  );
  const html = await started.text();
  const handle = new URL(
    html.match(/href="(https:\/\/[^"]+)"/)?.[1].replaceAll("&amp;", "&"),
  ).searchParams.get("state");
  const callback = `https://gw.test/install/callback?state=${handle}&installation_id=42`;
  assert.equal(
    (await handleInstallCallback(new Request(callback), env)).status,
    400,
  );
  assert.equal(
    (
      await handleInstallCallback(
        new Request(callback, {
          headers: { cookie: "__Host-WAYFORM_SETUP=wrong" },
        }),
        env,
      )
    ).status,
    400,
  );
});

test("install callback rejects an installation not owned by the pending user", async () => {
  const { beginInstallSetup, handleInstallCallback } =
    await import("../dist/gateway/src/setup.js");
  const env = makeEnv(undefined, { GITHUB_APP_SLUG: "wayform-test" });
  const started = await beginInstallSetup(
    new Request("https://gw.test/callback"),
    env,
    { oauthRequest: OAUTH_REQUEST, user: USER, allowedInstallationIds: [] },
  );
  const html = await started.text();
  const handle = new URL(
    html.match(/href="(https:\/\/[^"]+)"/)?.[1].replaceAll("&amp;", "&"),
  ).searchParams.get("state");
  await env.ROUTING.put(
    "installation:inventory:99",
    JSON.stringify({ senderGithubId: 202 }),
  );
  const response = await handleInstallCallback(
    new Request(
      `https://gw.test/install/callback?state=${handle}&installation_id=99`,
      {
        headers: {
          cookie: cookieNamed(started, "__Host-WAYFORM_SETUP"),
        },
      },
    ),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal(await env.ROUTING.get("space:inst:99"), null);
});

test("install callback renders a picker and valid selection completes OAuth", async () => {
  const calls = [];
  const env = makeEnv(
    ghFetch(calls, [
      [
        "/app/installations/42/access_tokens",
        () => Response.json({ token: "installation-secret" }),
      ],
      [
        "/installation/repositories",
        () =>
          Response.json({
            repositories: [
              {
                name: "memory",
                full_name: "ada/memory",
                owner: { login: "ada" },
                private: true,
                default_branch: "trunk",
              },
              {
                name: "second",
                full_name: "ada/second",
                owner: { login: "ada" },
                private: true,
                default_branch: "main",
              },
            ],
          }),
      ],
      [
        "/git/ref/heads/trunk",
        () => Response.json({ ref: "refs/heads/trunk" }),
      ],
    ]),
    {
      GITHUB_APP_SLUG: "wayform-test",
      OAUTH_PROVIDER: {
        async completeAuthorization(options) {
          assert.equal(options.request.clientId, "client-1");
          assert.equal(options.userId, "101");
          return {
            redirectTo:
              "http://127.0.0.1:9876/callback?code=oauth-code&state=client-state",
          };
        },
      },
    },
  );
  const {
    beginInstallSetup,
    handleInstallCallback,
    handleRepositorySelection,
  } = await import("../dist/gateway/src/setup.js");
  await env.ROUTING.put("signup:allowlist", JSON.stringify(["ada"]));
  const started = await beginInstallSetup(
    new Request("https://gw.test/callback"),
    env,
    { oauthRequest: OAUTH_REQUEST, user: USER },
  );
  const installHtml = await started.text();
  const handle = new URL(
    installHtml.match(/href="(https:\/\/[^"]+)"/)?.[1].replaceAll("&amp;", "&"),
  ).searchParams.get("state");
  const setupCookie = cookieNamed(started, "__Host-WAYFORM_SETUP");
  await env.ROUTING.put(
    "installation:inventory:42",
    JSON.stringify({ senderGithubId: 101 }),
  );
  const callback = await handleInstallCallback(
    new Request(
      `https://gw.test/install/callback?state=${handle}&installation_id=42`,
      { headers: { cookie: setupCookie } },
    ),
    env,
  );
  assert.equal(callback.status, 200);
  const picker = await callback.text();
  assert.match(picker, /ada\/memory/);
  assert.match(picker, /ada\/second/);
  const csrfCookie = cookieNamed(callback, "__Host-CSRF_TOKEN");
  const csrf = csrfCookie.split("=")[1];
  const selected = await handleRepositorySelection(
    new Request("https://gw.test/install/select", {
      method: "POST",
      headers: {
        cookie: `${setupCookie}; ${csrfCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        setup_handle: handle,
        csrf_token: csrf,
        repository: "ada/memory",
      }),
    }),
    env,
  );
  assert.equal(selected.status, 302);
  assert.match(selected.headers.get("location"), /code=oauth-code/);
  const space = JSON.parse(await env.ROUTING.get("space:inst:42"));
  assert.equal(space.repo, "memory");
  assert.equal(space.branch, "trunk");
  assert.equal(await env.OAUTH_KV.get(`oauth:setup:${handle}`), null);
  assert.ok(
    calls.some(
      ({ init }) =>
        init.headers?.authorization === "Bearer installation-secret",
    ),
  );
});

test("selection rejects public and branchless repositories", async () => {
  const { beginInstallSetup, handleRepositorySelection } =
    await import("../dist/gateway/src/setup.js");
  for (const repository of [
    {
      owner: "ada",
      repo: "public-memory",
      private: false,
      defaultBranch: "main",
    },
    {
      owner: "ada",
      repo: "empty-memory",
      private: true,
      defaultBranch: null,
    },
  ]) {
    const env = makeEnv(undefined, {
      GITHUB_APP_SLUG: "wayform-test",
      OAUTH_PROVIDER: { async completeAuthorization() {} },
    });
    await env.ROUTING.put("signup:allowlist", JSON.stringify(["ada"]));
    const started = await beginInstallSetup(
      new Request("https://gw.test/callback"),
      env,
      {
        oauthRequest: OAUTH_REQUEST,
        user: USER,
        installationId: 42,
        repositories: [repository],
      },
    );
    const html = await started.text();
    const handle = html.match(/name="setup_handle"\s+value="([^"]+)"/)?.[1];
    const setupCookie = cookieNamed(started, "__Host-WAYFORM_SETUP");
    const csrfCookie = cookieNamed(started, "__Host-CSRF_TOKEN");
    const response = await handleRepositorySelection(
      new Request("https://gw.test/install/select", {
        method: "POST",
        headers: {
          cookie: `${setupCookie}; ${csrfCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          setup_handle: handle,
          csrf_token: csrfCookie.split("=")[1],
          repository: `${repository.owner}/${repository.repo}`,
        }),
      }),
      env,
    );
    assert.equal(response.status, 400);
    assert.equal(await env.ROUTING.get("space:inst:42"), null);
  }
});

test("expired setup redirects access_denied to the original client", async () => {
  const { beginInstallSetup, handleInstallCallback } =
    await import("../dist/gateway/src/setup.js");
  const env = makeEnv(undefined, { GITHUB_APP_SLUG: "wayform-test" });
  const started = await beginInstallSetup(
    new Request("https://gw.test/callback"),
    env,
    { oauthRequest: OAUTH_REQUEST, user: USER },
  );
  const html = await started.text();
  const handle = new URL(
    html.match(/href="(https:\/\/[^"]+)"/)?.[1].replaceAll("&amp;", "&"),
  ).searchParams.get("state");
  const key = `oauth:setup:${handle}`;
  const pending = JSON.parse(await env.OAUTH_KV.get(key));
  pending.createdAt = 0;
  await env.OAUTH_KV.put(key, JSON.stringify(pending));
  const response = await handleInstallCallback(
    new Request(
      `https://gw.test/install/callback?state=${handle}&installation_id=42`,
      {
        headers: {
          cookie: cookieNamed(started, "__Host-WAYFORM_SETUP"),
        },
      },
    ),
    env,
  );
  assert.equal(response.status, 302);
  const redirect = new URL(response.headers.get("location"));
  assert.equal(redirect.origin + redirect.pathname, OAUTH_REQUEST.redirectUri);
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), "client-state");
});

test("KV-expired setup still returns access_denied to the original client", async () => {
  const { beginInstallSetup, handleInstallCallback } =
    await import("../dist/gateway/src/setup.js");
  const env = makeEnv(undefined, { GITHUB_APP_SLUG: "wayform-test" });
  const started = await beginInstallSetup(
    new Request("https://gw.test/callback"),
    env,
    { oauthRequest: OAUTH_REQUEST, user: USER },
  );
  const html = await started.text();
  const handle = new URL(
    html.match(/href="(https:\/\/[^"]+)"/)?.[1].replaceAll("&amp;", "&"),
  ).searchParams.get("state");
  await env.OAUTH_KV.delete(`oauth:setup:${handle}`);
  const response = await handleInstallCallback(
    new Request(
      `https://gw.test/install/callback?state=${handle}&installation_id=42`,
    ),
    env,
  );
  assert.equal(response.status, 302);
  const redirect = new URL(response.headers.get("location"));
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), "client-state");
});

test("an installation changed from GitHub settings is not reported as an error", async () => {
  // GitHub redirects to the App's Setup URL after ANY installation change,
  // including one made from the App settings page — installation_id but no
  // `state`, because no Wayform OAuth request started it. The change has
  // already been applied by then, so a 400 told the user their successful
  // install had failed.
  const { handleInstallCallback } =
    await import("../dist/gateway/src/setup.js");
  const env = makeEnv(undefined, { GITHUB_APP_SLUG: "wayform-test" });
  const res = await handleInstallCallback(
    new Request(
      "https://gw.test/install/callback?installation_id=155820548&setup_action=update",
    ),
    env,
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Installation updated/);
  assert.doesNotMatch(html, /invalid installation callback/);
});

test("a callback with no installation id is still a styled error", async () => {
  const { handleInstallCallback } =
    await import("../dist/gateway/src/setup.js");
  const env = makeEnv(undefined, { GITHUB_APP_SLUG: "wayform-test" });
  const res = await handleInstallCallback(
    new Request("https://gw.test/install/callback"),
    env,
  );
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Incomplete installation link/);
});
