import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import {
  resolveMember,
  newToken,
  getSpaceRepo,
  handleAdminListInstallations,
} from "../dist/gateway/src/tenancy.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  author: "Ada",
  authorEmail: "ada@acme.io",
};

async function addMember(env, body = MEMBER, secret = "test-admin-secret") {
  return handleRequest(
    new Request("https://gw.test/admin/members", {
      method: "POST",
      headers: { "x-admin-secret": secret, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

test("admin mint: returns a token once; token resolves to the member; branch defaults to main", async () => {
  const env = makeEnv();
  const res = await addMember(env);
  assert.equal(res.status, 200);
  const { token, member } = await res.json();
  assert.match(token, /^mlk_/);
  assert.equal(member.branch, "main");

  const resolved = await resolveMember(
    new Request("https://gw.test/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(resolved.space, "team-a");
  assert.equal(resolved.author, "Ada");

  // the raw token never lands in KV — only its hash key exists
  for (const key of env.ROUTING.map.keys()) {
    assert.ok(!key.includes(token), "raw token must not appear in any KV key");
  }
});

test("admin mint rejects a wrong secret and missing fields", async () => {
  const env = makeEnv();
  assert.equal((await addMember(env, MEMBER, "wrong")).status, 403);
  const { space: _drop, ...incomplete } = MEMBER;
  assert.equal((await addMember(env, incomplete)).status, 400);
});

test("resolveMember: absent/garbage/unknown bearer all resolve to null", async () => {
  const env = makeEnv();
  const mk = (headers) => new Request("https://gw.test/mcp", { headers });
  assert.equal(await resolveMember(mk({}), env), null);
  assert.equal(
    await resolveMember(mk({ authorization: "Basic abc" }), env),
    null,
  );
  assert.equal(
    await resolveMember(mk({ authorization: `Bearer ${newToken()}` }), env),
    null,
  );
});

test("minting a member registers its repo in the spaces registry", async () => {
  const env = makeEnv();
  const res = await addMember(env);
  assert.equal(res.status, 200);
  const sr = await getSpaceRepo(env, "acme/team-a-memory");
  assert.deepEqual(sr, {
    space: "team-a",
    installationId: 777,
    owner: "acme",
    repo: "team-a-memory",
    branch: "main",
  });
});

test("resolveMember: token can arrive via /mcp/<token> path or ?key= query", async () => {
  const env = makeEnv();
  const { token } = await (await addMember(env)).json();
  const viaPath = await resolveMember(
    new Request(`https://gw.test/mcp/${token}`),
    env,
  );
  const viaQuery = await resolveMember(
    new Request(`https://gw.test/mcp?key=${token}`),
    env,
  );
  assert.equal(viaPath.space, "team-a");
  assert.equal(viaQuery.space, "team-a");
});

test("resolveMember: header wins over a URL-borne token", async () => {
  const env = makeEnv();
  const a = await (await addMember(env)).json();
  const b = await (
    await addMember(env, { ...MEMBER, space: "team-b", repo: "team-b-memory" })
  ).json();
  // header = a, path = b → header should win
  const resolved = await resolveMember(
    new Request(`https://gw.test/mcp/${b.token}`, {
      headers: { authorization: `Bearer ${a.token}` },
    }),
    env,
  );
  assert.equal(resolved.repo, "team-a-memory");
});

test("router: POST /mcp/<token> reaches the mcp handler (not 404)", async () => {
  const env = makeEnv();
  const { token } = await (await addMember(env)).json();
  const res = await handleRequest(
    new Request(`https://gw.test/mcp/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    }),
    env,
  );
  assert.notEqual(res.status, 404);
  assert.notEqual(res.status, 401);
});

test("two members in different spaces resolve to their own records", async () => {
  const env = makeEnv();
  const a = await (await addMember(env)).json();
  const b = await (
    await addMember(env, {
      ...MEMBER,
      space: "team-b",
      owner: "acme",
      repo: "team-b-memory",
      installationId: 888,
      author: "Bo",
    })
  ).json();
  const resolve = async (tok) =>
    resolveMember(
      new Request("https://gw.test/mcp", {
        headers: { authorization: `Bearer ${tok}` },
      }),
      env,
    );
  assert.equal((await resolve(a.token)).repo, "team-a-memory");
  assert.equal((await resolve(b.token)).repo, "team-b-memory");
});

function listInstallations(env, owner, secret = "test-admin-secret") {
  return handleRequest(
    new Request(
      `https://gw.test/admin/installations?owner=${encodeURIComponent(owner)}`,
      { headers: { "x-admin-secret": secret } },
    ),
    env,
  );
}

test("admin installations: 403 on wrong/missing secret", async () => {
  const env = makeEnv();
  const res = await listInstallations(env, "acme", "wrong");
  assert.equal(res.status, 403);
});

test("admin installations: 400 when owner query param is missing", async () => {
  const env = makeEnv();
  const res = await handleRequest(
    new Request("https://gw.test/admin/installations", {
      headers: { "x-admin-secret": "test-admin-secret" },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("admin installations: 200 with installationId on a single case-insensitive match", async () => {
  const fetchImpl = ghFetch(
    [],
    [
      [
        "/app/installations?per_page=100",
        () =>
          Response.json([
            { id: 111, account: { login: "OtherOrg" } },
            { id: 222, account: { login: "Acme" } },
          ]),
      ],
    ],
  );
  const env = makeEnv(fetchImpl);
  const res = await listInstallations(env, "acme");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { installationId: 222 });
});

test("admin installations: 404 when no installation matches the owner", async () => {
  const fetchImpl = ghFetch(
    [],
    [
      [
        "/app/installations?per_page=100",
        () => Response.json([{ id: 111, account: { login: "OtherOrg" } }]),
      ],
    ],
  );
  const env = makeEnv(fetchImpl);
  const res = await listInstallations(env, "acme");
  assert.equal(res.status, 404);
});

test("admin installations: 409 with all matching IDs when the owner is ambiguous", async () => {
  const fetchImpl = ghFetch(
    [],
    [
      [
        "/app/installations?per_page=100",
        () =>
          Response.json([
            { id: 111, account: { login: "acme" } },
            { id: 222, account: { login: "acme" } },
          ]),
      ],
    ],
  );
  const env = makeEnv(fetchImpl);
  const res = await listInstallations(env, "acme");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.deepEqual(body.installationIds.sort(), [111, 222]);
});

test("admin installations: 502 when GitHub's API call fails", async () => {
  const fetchImpl = ghFetch(
    [],
    [
      [
        "/app/installations?per_page=100",
        () => new Response("nope", { status: 500 }),
      ],
    ],
  );
  const env = makeEnv(fetchImpl);
  const res = await listInstallations(env, "acme");
  assert.equal(res.status, 502);
});
