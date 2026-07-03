import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextStore } from "../dist/store.js";
import { recordMetric } from "../dist/metrics.js";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fresh tmp dir + a bare "remote" seeded with a main branch and one commit. */
function freshRemote() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-it-"));
  const bare = path.join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--initial-branch=main", bare);
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", bare, seed);
  fs.writeFileSync(path.join(seed, "README.md"), "shared\n");
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
  return { tmp, bare };
}

function makeStore(bare, clonePath, author, autoPush = true) {
  return new ContextStore({
    repoUrl: bare,
    repoPath: clonePath,
    author,
    authorEmail: `${author.toLowerCase()}@memorylayer.local`,
    autoPush,
  });
}

function cfgFor(bare, clonePath, author, autoPush = true) {
  return {
    repoUrl: bare,
    repoPath: clonePath,
    author,
    authorEmail: `${author.toLowerCase()}@memorylayer.local`,
    autoPush,
  };
}

test("core round-trip: A writes, B reads it unpasted", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const a = makeStore(bare, path.join(tmp, "a"), "Alice");
    const b = makeStore(bare, path.join(tmp, "b"), "Bob");
    await a.ensure();
    await b.ensure();

    await a.write("proj", {
      author: "Alice",
      type: "decision",
      payload: "Ship the per-author file model.",
    });
    const { entries, total } = await b.read("proj");
    assert.equal(total, 1);
    assert.equal(entries[0].author, "Alice");
    assert.match(entries[0].payload, /per-author file model/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("in-process concurrent writes each get their own single-file commit (A2)", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "c"), "Alice", false);
    await s.ensure();
    const clone = path.join(tmp, "c");

    await Promise.all([
      s.write("proj", {
        author: "Alice",
        type: "context",
        payload: "note one",
      }),
      s.write("proj", {
        author: "Alice",
        type: "context",
        payload: "note two",
      }),
    ]);

    // Two commits touching context/, and no commit bundles more than one file.
    const hashes = git(clone, "log", "--format=%H", "--", "context/")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(hashes.length, 2, "each write is its own commit");
    for (const h of hashes) {
      const files = git(clone, "show", "--name-only", "--format=", h)
        .trim()
        .split("\n")
        .filter((l) => l.endsWith(".md"));
      assert.equal(
        files.length,
        1,
        `commit ${h} touches exactly one entry file`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("read packs entries into a token budget, keeping the most recent (A3)", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "d"), "Alice", false);
    await s.ensure();
    // Each payload is ~400 chars -> ~100 tokens + 12 overhead = ~112 tokens/entry.
    const big = "x".repeat(400);
    for (let i = 0; i < 10; i++) {
      await s.write("proj", {
        author: "Alice",
        type: "context",
        payload: `${big}-${i}`,
      });
    }
    // Budget for ~3 entries (112 * 3 = 336, leave headroom short of 4 entries).
    const { entries, total } = await s.read("proj", 340);
    assert.equal(total, 10, "total counts every entry regardless of budget");
    assert.ok(entries.length < 10, "budget excludes older entries");
    assert.ok(entries.length >= 1, "at least one entry always returned");
    assert.match(
      entries[entries.length - 1].payload,
      /-9$/,
      "most recent entry kept",
    );
    assert.match(
      entries[0].payload,
      /-9$|-8$|-7$/,
      "kept entries are the most recent, in order",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("read keeps the single most recent entry even if it alone exceeds the budget", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "d2"), "Alice", false);
    await s.ensure();
    await s.write("proj", {
      author: "Alice",
      type: "context",
      payload: "x".repeat(4000),
    });
    const { entries, total } = await s.read("proj", 10); // budget far too small
    assert.equal(total, 1);
    assert.equal(
      entries.length,
      1,
      "never returns zero entries when data exists",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("budgetTokens <= 0 means unlimited (back-compat escape hatch)", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "d3"), "Alice", false);
    await s.ensure();
    for (let i = 0; i < 5; i++) {
      await s.write("proj", {
        author: "Alice",
        type: "context",
        payload: `entry ${i}`,
      });
    }
    const { entries } = await s.read("proj", 0);
    assert.equal(entries.length, 5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("entries come back in write (timestamp) order", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "e"), "Alice", false);
    await s.ensure();
    for (const p of ["first", "second", "third"]) {
      await s.write("proj", { author: "Alice", type: "context", payload: p });
      await sleep(5); // distinct millisecond timestamps
    }
    const { entries } = await s.read("proj");
    assert.deepEqual(
      entries.map((e) => e.payload),
      ["first", "second", "third"],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("push failure surfaces an honest 'recorded locally' error (A4)", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "f"), "Alice", true);
    await s.ensure();
    // Break the remote after cloning: the write commits locally, push fails.
    fs.rmSync(bare, { recursive: true, force: true });
    await assert.rejects(
      () =>
        s.write("proj", {
          author: "Alice",
          type: "decision",
          payload: "stranded",
        }),
      /Recorded locally, NOT shared yet/,
    );
    // The decision is still recorded in the local clone (not lost).
    const { total } = await s.read("proj");
    assert.equal(total, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("flushMetrics commits and pushes the author's metrics log", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const cfg = cfgFor(bare, path.join(tmp, "a"), "Alice");
    const a = new ContextStore(cfg);
    await a.ensure();

    // Simulate a read and a write having appended metric lines locally.
    await recordMetric(cfg, {
      source: "hook",
      event: "read",
      project: "proj",
      total: 0,
    });
    await recordMetric(cfg, { source: "mcp", event: "write", project: "proj" });

    await a.flushMetrics();

    // A fresh clone from the bare remote must now contain the pushed log.
    const verify = path.join(tmp, "verify");
    git(tmp, "clone", bare, verify);
    const metricsFile = path.join(verify, "metrics", "alice.jsonl");
    assert.ok(fs.existsSync(metricsFile), "metrics log reached the remote");
    const lines = fs.readFileSync(metricsFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("flushMetrics is a silent no-op when nothing was recorded", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const cfg = cfgFor(bare, path.join(tmp, "a"), "Alice");
    const a = new ContextStore(cfg);
    await a.ensure();
    await a.flushMetrics(); // no metrics file exists yet
    // Assert that no "metrics: sync" commit was created
    const log = git(path.join(tmp, "a"), "log", "--oneline").toString();
    assert.equal(/metrics: sync/.test(log), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
