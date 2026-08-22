import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import {
  resolveMember,
  handleAdminListInstallations,
} from "../dist/gateway/src/tenancy.js";
import { makeEnv, ghFetch, seedGithubMember } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  author: "Ada",
  authorEmail: "ada@acme.io",
  githubId: 101,
  githubLogin: "ada",
  role: "admin",
};

test("seeded github member resolves via oauth props; unknown id is null", async () => {
  const env = makeEnv();
  await seedGithubMember(env, MEMBER);
  const resolved = await resolveMember(
    new Request("https://gw.test/mcp"),
    env,
    { props: { githubId: 101, githubLogin: "ada" } },
  );
  assert.equal(resolved.space, "team-a");
  assert.equal(resolved.author, "Ada");
  assert.equal(resolved.githubId, 101);
  assert.equal(
    await resolveMember(new Request("https://gw.test/mcp"), env),
    null,
  );
  assert.equal(
    await resolveMember(new Request("https://gw.test/mcp"), env, {
      props: { githubId: 999 },
    }),
    null,
  );
});

test("minting routes are gone; github members still register the space repo", async () => {
  const env = makeEnv();
  await seedGithubMember(env, MEMBER);
  const { getSpaceRepo } = await import("../dist/gateway/src/tenancy.js");
  const sr = await getSpaceRepo(env, "acme/team-a-memory");
  assert.deepEqual(sr, {
    space: "team-a",
    installationId: 777,
    owner: "acme",
    repo: "team-a-memory",
    branch: "main",
  });
  const mint = await handleRequest(
    new Request("https://gw.test/admin/members", {
      method: "POST",
      headers: {
        "x-admin-secret": "test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(MEMBER),
    }),
    env,
  );
  assert.equal(mint.status, 404);
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
