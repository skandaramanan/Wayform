import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSpaceCreateArgs,
  resolveAdminSecret,
  ghAuthenticated,
  createRepoWithGh,
  createRepoWithPat,
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
