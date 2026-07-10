import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSpaceCreateArgs,
  resolveAdminSecret,
  ghAuthenticated,
  createRepoWithGh,
  createRepoWithPat,
  pollInstallation,
} from "../dist/space-create.js";

test("parseSpaceCreateArgs reads required flags and defaults isPublic to false", () => {
  const parsed = parseSpaceCreateArgs([
    "--space",
    "team-a",
    "--owner",
    "acme",
    "--repo",
    "team-a-memory",
    "--app-slug",
    "wayform-memory",
  ]);
  assert.deepEqual(parsed, {
    space: "team-a",
    owner: "acme",
    repo: "team-a-memory",
    isPublic: false,
    appSlug: "wayform-memory",
    author: undefined,
    authorEmail: undefined,
  });
});

test("parseSpaceCreateArgs reads --public, --author, --author-email overrides", () => {
  const parsed = parseSpaceCreateArgs([
    "--space",
    "team-a",
    "--owner",
    "acme",
    "--repo",
    "team-a-memory",
    "--app-slug",
    "wayform-memory",
    "--public",
    "--author",
    "Ada",
    "--author-email",
    "ada@acme.io",
  ]);
  assert.equal(parsed.isPublic, true);
  assert.equal(parsed.author, "Ada");
  assert.equal(parsed.authorEmail, "ada@acme.io");
});

test("parseSpaceCreateArgs falls back to WAYFORM_GITHUB_APP_SLUG env var", () => {
  process.env.WAYFORM_GITHUB_APP_SLUG = "env-slug";
  try {
    const parsed = parseSpaceCreateArgs([
      "--space",
      "team-a",
      "--owner",
      "acme",
      "--repo",
      "team-a-memory",
    ]);
    assert.equal(parsed.appSlug, "env-slug");
  } finally {
    delete process.env.WAYFORM_GITHUB_APP_SLUG;
  }
});

test("parseSpaceCreateArgs throws when --space, --owner, or --repo is missing", () => {
  assert.throws(() => parseSpaceCreateArgs(["--owner", "acme", "--repo", "r"]));
  assert.throws(() => parseSpaceCreateArgs(["--space", "s", "--repo", "r"]));
  assert.throws(() => parseSpaceCreateArgs(["--space", "s", "--owner", "acme"]));
});

test("parseSpaceCreateArgs throws when no app slug is available", () => {
  delete process.env.WAYFORM_GITHUB_APP_SLUG;
  assert.throws(
    () =>
      parseSpaceCreateArgs([
        "--space",
        "s",
        "--owner",
        "acme",
        "--repo",
        "r",
      ]),
    /app-slug/,
  );
});

test("resolveAdminSecret reads WAYFORM_ADMIN_SECRET, throws when unset", () => {
  const prev = process.env.WAYFORM_ADMIN_SECRET;
  try {
    process.env.WAYFORM_ADMIN_SECRET = "shh";
    assert.equal(resolveAdminSecret(), "shh");
    delete process.env.WAYFORM_ADMIN_SECRET;
    assert.throws(() => resolveAdminSecret(), /WAYFORM_ADMIN_SECRET/);
  } finally {
    if (prev === undefined) delete process.env.WAYFORM_ADMIN_SECRET;
    else process.env.WAYFORM_ADMIN_SECRET = prev;
  }
});

test("ghAuthenticated returns true when `gh auth status` succeeds", () => {
  assert.equal(
    ghAuthenticated(() => {}),
    true,
  );
});

test("ghAuthenticated returns false when the run throws (gh absent or unauthenticated)", () => {
  assert.equal(
    ghAuthenticated(() => {
      throw new Error("spawn gh ENOENT");
    }),
    false,
  );
});

test("createRepoWithGh shells out to `gh repo create` with --private by default", () => {
  let seen;
  createRepoWithGh("acme", "team-a-memory", false, (cmd, args) => {
    seen = { cmd, args };
  });
  assert.equal(seen.cmd, "gh");
  assert.deepEqual(seen.args, [
    "repo",
    "create",
    "acme/team-a-memory",
    "--private",
  ]);
});

test("createRepoWithGh passes --public when isPublic is true", () => {
  let seen;
  createRepoWithGh("acme", "team-a-memory", true, (cmd, args) => {
    seen = { cmd, args };
  });
  assert.deepEqual(seen.args.at(-1), "--public");
});

test("createRepoWithPat tries the org endpoint first and succeeds there", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.authorization, "Bearer pat_x");
    return new Response("{}", { status: 201 });
  };
  await createRepoWithPat("acme", "team-a-memory", false, "pat_x", fetchImpl);
  assert.deepEqual(calls, ["https://api.github.com/orgs/acme/repos"]);
});

test("createRepoWithPat falls back to /user/repos when the org endpoint 404s", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/orgs/")) return new Response("nope", { status: 404 });
    return new Response("{}", { status: 201 });
  };
  await createRepoWithPat("skanda", "personal-space", false, "pat_x", fetchImpl);
  assert.deepEqual(calls, [
    "https://api.github.com/orgs/skanda/repos",
    "https://api.github.com/user/repos",
  ]);
});

test("createRepoWithPat throws with GitHub's error body when both endpoints fail", async () => {
  const fetchImpl = async (url) =>
    String(url).includes("/orgs/")
      ? new Response("nope", { status: 404 })
      : new Response("already exists", { status: 422 });
  await assert.rejects(
    () => createRepoWithPat("acme", "team-a-memory", false, "pat_x", fetchImpl),
    /422.*already exists/s,
  );
});

test("pollInstallation returns installationId as soon as the gateway reports 200", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(init.headers["x-admin-secret"], "secret");
    assert.equal(
      String(url),
      "https://gw.example.com/admin/installations?owner=acme",
    );
    return Response.json({ installationId: 42 });
  };
  const id = await pollInstallation(
    "https://gw.example.com",
    "secret",
    "acme",
    fetchImpl,
    { intervalMs: 10, timeoutMs: 1000 },
    async () => {},
  );
  assert.equal(id, 42);
  assert.equal(calls, 1);
});

test("pollInstallation retries on 404 (not installed yet) until it succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls < 3
      ? new Response("{}", { status: 404 })
      : Response.json({ installationId: 7 });
  };
  const sleeps = [];
  const id = await pollInstallation(
    "https://gw.example.com",
    "secret",
    "acme",
    fetchImpl,
    { intervalMs: 10, timeoutMs: 5000 },
    async (ms) => sleeps.push(ms),
  );
  assert.equal(id, 7);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 10]);
});

test("pollInstallation throws immediately on 409 (ambiguous match)", async () => {
  const fetchImpl = async () =>
    Response.json(
      { error: "ambiguous", installationIds: [1, 2] },
      { status: 409 },
    );
  await assert.rejects(
    () =>
      pollInstallation(
        "https://gw.example.com",
        "secret",
        "acme",
        fetchImpl,
        { intervalMs: 10, timeoutMs: 5000 },
        async () => {},
      ),
    /1, 2/,
  );
});

test("pollInstallation throws with a manual-fallback message on timeout", async () => {
  const fetchImpl = async () => new Response("{}", { status: 404 });
  await assert.rejects(
    () =>
      pollInstallation(
        "https://gw.example.com",
        "secret",
        "acme",
        fetchImpl,
        { intervalMs: 1000, timeoutMs: 1 },
        async () => {},
      ),
    /Timed out.*admin\/members/s,
  );
});
