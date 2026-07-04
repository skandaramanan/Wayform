import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRepo } from "../dist/git-repo.js";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** A fresh bare repo seeded with one commit on main. Returns its path. */
function bareRepo(tmp, name) {
  const bare = path.join(tmp, name);
  git(tmp, "init", "--bare", "--initial-branch=main", bare);
  const seed = path.join(tmp, `${name}-seed`);
  git(tmp, "clone", bare, seed);
  fs.writeFileSync(path.join(seed, "README.md"), name);
  git(seed, "add", ".");
  git(
    seed,
    "-c",
    "user.email=s@x",
    "-c",
    "user.name=seed",
    "commit",
    "-m",
    "init",
  );
  git(seed, "push", "origin", "main");
  return bare;
}

function cfg(repoUrl, repoPath) {
  return {
    repoUrl,
    repoPath,
    author: "Alice",
    authorEmail: "alice@memorylayer.local",
    autoPush: true,
    readBudgetTokens: 4000,
  };
}

const originUrl = (repoPath) => git(repoPath, "remote", "get-url", "origin");

test("ensure() sets origin to repoUrl on a fresh clone", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-gr-"));
  try {
    const a = bareRepo(tmp, "a.git");
    const clone = path.join(tmp, "clone");
    await new GitRepo(cfg(a, clone)).ensure();
    assert.equal(originUrl(clone), a);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensure() re-points a mis-targeted existing clone to the configured repoUrl", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-gr-"));
  try {
    const a = bareRepo(tmp, "a.git");
    const b = bareRepo(tmp, "b.git");
    const clone = path.join(tmp, "clone");
    // First run clones A → origin points at A.
    await new GitRepo(cfg(a, clone)).ensure();
    assert.equal(originUrl(clone), a);
    // Second run at the SAME path but configured for B → origin must become B.
    await new GitRepo(cfg(b, clone)).ensure();
    assert.equal(originUrl(clone), b);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensure() adds origin when an existing git repo has no remotes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-gr-"));
  try {
    const a = bareRepo(tmp, "a.git");
    const clone = path.join(tmp, "clone");
    fs.mkdirSync(clone);
    git(clone, "init", "--initial-branch=main");

    await new GitRepo(cfg(a, clone)).ensure();

    assert.equal(originUrl(clone), a);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
