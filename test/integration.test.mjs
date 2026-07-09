import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run the built hook asynchronously (so an in-process HTTP server keeps serving
 * on the parent event loop), with stdin set to "ignore" so the hook's drainStdin
 * gets an immediate EOF instead of blocking forever on an open pipe.
 */
function runHookAsync(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookJs], {
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}
import { ContextStore } from "../dist/store.js";
import { recordMetric } from "../dist/metrics.js";
import { serializeEntry } from "../dist/frontmatter.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const hookJs = fileURLToPath(new URL("../dist/hook.js", import.meta.url));

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

test("read recovers untracked entry orphans from an interrupted prior write", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "orphan"), "Alice", true);
    await s.ensure();
    const relFile = path.join(
      "context",
      "proj",
      "alice",
      "2026-01-01T00-00-00-000Z-orphan.md",
    );
    const absFile = path.join(tmp, "orphan", relFile);
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    fs.writeFileSync(
      absFile,
      serializeEntry(
        {
          author: "Alice",
          type: "decision",
          timestamp: "2026-01-01T00:00:00.000Z",
          id: "orphan",
          project: "proj",
        },
        "Recover the orphaned decision.",
      ),
    );

    const { entries, total } = await s.read("proj");

    assert.equal(total, 1);
    assert.equal(entries[0].payload, "Recover the orphaned decision.");
    const verify = path.join(tmp, "verify-orphan");
    git(tmp, "clone", bare, verify);
    assert.ok(
      fs.existsSync(path.join(verify, relFile)),
      "recovered orphan reached the remote",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("read order follows git commit order when entry timestamps are clock-skewed", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "skew"), "Alice", false);
    await s.ensure();
    const clone = path.join(tmp, "skew");
    const entries = [
      {
        relFile: path.join(
          "context",
          "proj",
          "alice",
          "2099-01-01T00-00-00-000Z-first.md",
        ),
        timestamp: "2099-01-01T00:00:00.000Z",
        payload: "committed first with a future wall clock",
      },
      {
        relFile: path.join(
          "context",
          "proj",
          "alice",
          "2000-01-01T00-00-00-000Z-second.md",
        ),
        timestamp: "2000-01-01T00:00:00.000Z",
        payload: "committed second with a past wall clock",
      },
    ];

    for (const entry of entries) {
      const absFile = path.join(clone, entry.relFile);
      fs.mkdirSync(path.dirname(absFile), { recursive: true });
      fs.writeFileSync(
        absFile,
        serializeEntry(
          {
            author: "Alice",
            type: "context",
            timestamp: entry.timestamp,
            id: path.basename(entry.relFile, ".md"),
            project: "proj",
          },
          entry.payload,
        ),
      );
      git(clone, "add", entry.relFile);
      git(
        clone,
        "-c",
        "user.email=alice@memorylayer.local",
        "-c",
        "user.name=Alice",
        "commit",
        "-m",
        `context(proj): ${entry.payload}`,
      );
      await sleep(1100);
    }

    const { entries: readEntries } = await s.read("proj");

    assert.deepEqual(
      readEntries.map((entry) => entry.payload),
      [
        "committed first with a future wall clock",
        "committed second with a past wall clock",
      ],
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

test("independent clones can race writes and both reach the shared remote", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const a = makeStore(bare, path.join(tmp, "race-a"), "Alice");
    const b = makeStore(bare, path.join(tmp, "race-b"), "Bob");
    await a.ensure();
    await b.ensure();

    await Promise.all([
      a.write("proj", {
        author: "Alice",
        type: "decision",
        payload: "Alice writes during the race.",
      }),
      b.write("proj", {
        author: "Bob",
        type: "decision",
        payload: "Bob writes during the race.",
      }),
    ]);

    const verify = makeStore(bare, path.join(tmp, "race-verify"), "Verifier");
    await verify.ensure();
    const { entries, total } = await verify.read("proj");

    assert.equal(total, 2);
    assert.deepEqual(entries.map((entry) => entry.payload).sort(), [
      "Alice writes during the race.",
      "Bob writes during the race.",
    ]);
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

test("gateway-only hook injects the gateway's /hook/read text (no clone)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/hook/read")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("SHARED MEMORY FROM GATEWAY");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const stdout = await runHookAsync({
      PATH: process.env.PATH ?? "",
      MEMORYLAYER_HOOK_CLIENT: "raw",
      MEMORYLAYER_AUTHOR: "Dana",
      MEMORYLAYER_PROJECT: "acme-eng",
      MEMORYLAYER_GATEWAY_URL: `http://127.0.0.1:${port}`,
      MEMORYLAYER_GATEWAY_TOKEN: "mlk_x",
      // deliberately NO CONTEXT_REPO_URL — hosted-only member
    });
    assert.match(stdout, /SHARED MEMORY FROM GATEWAY/);
  } finally {
    server.close();
  }
});

test("gateway-only hook fails open (no clone, unreachable gateway) and writes no stray files", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-gwonly-"));
  try {
    const out = execFileSync(process.execPath, [hookJs], {
      cwd,
      input: "",
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        MEMORYLAYER_HOOK_CLIENT: "claude-code",
        MEMORYLAYER_AUTHOR: "Dana",
        MEMORYLAYER_PROJECT: "acme-eng",
        MEMORYLAYER_GATEWAY_URL: "http://127.0.0.1:1",
        MEMORYLAYER_GATEWAY_TOKEN: "mlk_unreachable",
      },
    });
    assert.equal(out.trim(), "{}"); // empty no-op, exit 0
    assert.ok(
      !fs.existsSync(path.join(cwd, "metrics")),
      "no stray metrics dir",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("init --remote writes hosted config set, gitignores the token file, no committed .mcp.json", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-initremote-"));
  execFileSync("git", ["init", "-q"], { cwd });
  try {
    execFileSync(
      process.execPath,
      [
        cliPath,
        "init",
        "--remote",
        "--gateway",
        "https://gw.example.com",
        "--token",
        "mlk_x",
        "--project",
        "acme-eng",
        "--author",
        "Dana",
        "--email",
        "dana@acme.com",
        "--yes",
      ],
      // Empty PATH so the Claude-CLI shell-out ENOENTs immediately: the helper
      // fails open (prints the manual command) and init completes — with no real
      // `claude mcp add` invocation mutating the developer's ~/.claude.json.
      { cwd, encoding: "utf8", env: { PATH: "" } },
    );

    const env = fs.readFileSync(
      path.join(cwd, ".memorylayer-hook.env"),
      "utf8",
    );
    assert.match(env, /MEMORYLAYER_GATEWAY_URL=https:\/\/gw\.example\.com/);
    assert.match(env, /MEMORYLAYER_GATEWAY_TOKEN=mlk_x/);
    assert.ok(!/CONTEXT_REPO_URL/.test(env));

    const cursorMcp = JSON.parse(
      fs.readFileSync(path.join(cwd, ".cursor/mcp.json"), "utf8"),
    );
    assert.equal(
      cursorMcp.mcpServers.wayform.url,
      "https://gw.example.com/mcp",
    );
    assert.equal(
      cursorMcp.mcpServers.wayform.headers.Authorization,
      "Bearer mlk_x",
    );

    const claude = JSON.parse(
      fs.readFileSync(path.join(cwd, ".claude/settings.json"), "utf8"),
    );
    assert.equal(
      claude.hooks.SessionStart[0].hooks[0].command,
      "wayform hook claude-code",
    );

    const gi = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    assert.match(gi, /^\.cursor\/mcp\.json$/m);
    assert.match(gi, /^\.memorylayer-hook\.env$/m);

    assert.ok(
      !fs.existsSync(path.join(cwd, ".mcp.json")),
      "hosted members do not get the committed stdio .mcp.json",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
