import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordMetric, metricsRelPath } from "../dist/metrics.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ml-metrics-"));
}

function cfgFor(repoPath, author = "Alice Example") {
  return {
    repoUrl: "unused",
    repoPath,
    author,
    authorEmail: "a@x",
    autoPush: true,
  };
}

test("metricsRelPath slugs the author into metrics/<slug>.jsonl", () => {
  assert.equal(
    metricsRelPath("Alice Example"),
    path.join("metrics", "alice-example.jsonl"),
  );
});

test("recordMetric appends a well-formed read line and auto-creates metrics/", async () => {
  const repoPath = tmpRepo();
  const cfg = cfgFor(repoPath);
  await recordMetric(cfg, {
    source: "hook",
    event: "read",
    project: "proj",
    total: 3,
  });

  const file = path.join(repoPath, metricsRelPath(cfg.author));
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.author, "Alice Example");
  assert.equal(rec.source, "hook");
  assert.equal(rec.event, "read");
  assert.equal(rec.project, "proj");
  assert.equal(rec.total, 3);
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("write metric omits total even when one is passed", async () => {
  const repoPath = tmpRepo();
  const cfg = cfgFor(repoPath);
  await recordMetric(cfg, {
    source: "mcp",
    event: "write",
    project: "proj",
    total: 5,
  });

  const rec = JSON.parse(
    fs
      .readFileSync(path.join(repoPath, metricsRelPath(cfg.author)), "utf8")
      .trim(),
  );
  assert.equal(rec.event, "write");
  assert.equal("total" in rec, false);
});

test("recordMetric never throws when the repo path is unwritable (fail-open)", async () => {
  const notADir = path.join(tmpRepo(), "not-a-dir");
  fs.writeFileSync(notADir, "x"); // a FILE, so mkdir(metrics/) under it fails
  const cfg = cfgFor(notADir);
  await recordMetric(cfg, {
    source: "hook",
    event: "read",
    project: "p",
    total: 1,
  });
  const file = path.join(notADir, metricsRelPath(cfg.author));
  assert.equal(fs.existsSync(file), false);
});

test("multiple metrics accumulate as separate lines", async () => {
  const repoPath = tmpRepo();
  const cfg = cfgFor(repoPath);
  await recordMetric(cfg, {
    source: "hook",
    event: "read",
    project: "p",
    total: 1,
  });
  await recordMetric(cfg, { source: "mcp", event: "write", project: "p" });
  const lines = fs
    .readFileSync(path.join(repoPath, metricsRelPath(cfg.author)), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
});
