import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSpaceCreateArgs,
  resolveAdminSecret,
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
