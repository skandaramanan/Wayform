// 2026-09-18 extraction-fidelity fixes: invented specifics are dropped, calls
// run at temperature 0, and supersession
// survives re-extraction by similarity.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFactsDetailed,
  isGrounded,
} from "../dist/gateway/src/extract.js";
import { indexDeps } from "../dist/gateway/src/deps.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { ingestEntriesDetailed } from "../dist/gateway/src/ingest.js";
import { FakeKV, fakeEmbed } from "./helpers.mjs";

const entry = (payload) => ({
  author: "A",
  type: "decision",
  timestamp: "2026-09-18T00:00:00Z",
  id: "e1",
  payload,
  file: "context/p/a/e1.md",
});
const long = (s) => s + " " + "Background detail. ".repeat(20);

test("isGrounded rejects invented dates, versions, numbers and identifiers", () => {
  const src =
    "The root dist/ is no longer checked in since PR #32 (ce453df) on 2026-07-21. RL_AUTH is 20/min.";
  assert.equal(isGrounded("dist/ is no longer checked in", src), true);
  assert.equal(isGrounded("Landed in PR #32, commit ce453df", src), true);
  assert.equal(isGrounded("RL_AUTH allows 20 requests per minute", src), true);
  assert.equal(isGrounded("Decided on 2022-12-15", src), false);
  assert.equal(isGrounded("Uses Node.js 14.17.0", src), false);
  assert.equal(isGrounded("Watch it for 24 hours", src), false);
  assert.equal(isGrounded("Added `query_field` to the log", src), false);
  assert.equal(isGrounded("RL_API is 240/min", src), false);
});

test("model facts with invented specifics are dropped, grounded ones kept", async () => {
  const source = long("We shipped PR #45 on 2026-08-31.");
  const gen = async () =>
    JSON.stringify([
      {
        kind: "decision",
        tier: "normal",
        body: "PR #45 shipped on 2026-08-31",
        entities: [],
      },
      {
        kind: "decision",
        tier: "normal",
        body: "It was reviewed on 2022-12-15",
        entities: [],
      },
    ]);
  const { facts, floored } = await extractFactsDetailed(gen, entry(source));
  assert.equal(floored, false);
  assert.deepEqual(
    facts.map((f) => f.body),
    ["PR #45 shipped on 2026-08-31"],
  );
});

test("an entry whose every fact is invented is kept whole and not retried", async () => {
  const gen = async () =>
    JSON.stringify([
      {
        kind: "decision",
        tier: "normal",
        body: "Made on 2023-02-20",
        entities: [],
      },
    ]);
  const source = long("The smoke test wrote one entry.");
  const { facts, floored } = await extractFactsDetailed(gen, entry(source));
  assert.equal(floored, false, "a temperature-0 retry would repeat it");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].body, source);
});

test("extraction and judge calls run at temperature 0", async () => {
  const seen = [];
  const { gen } = indexDeps({
    indexDb: new MemoryIndexDb(),
    ROUTING: new FakeKV(),
    AI: {
      async run(model, input) {
        seen.push(input);
        return input.text ? { data: [[1]] } : { response: "[]" };
      },
    },
  });
  await gen("x", { purpose: "extract" });
  await gen("y", { purpose: "judge" });
  assert.ok(seen.every((i) => i.temperature === 0));
});

test("a superseded fact keeps its supersession when re-extraction renames it", async () => {
  const db = new MemoryIndexDb();
  const e = entry(
    long("Commit the dist folder to the repo so installs need no toolchain."),
  );
  const first = async () =>
    JSON.stringify([
      {
        kind: "decision",
        tier: "normal",
        body: "commit the dist folder to the repo so installs need no toolchain",
        entities: ["dist"],
      },
      {
        kind: "context",
        tier: "normal",
        body: "background detail",
        entities: ["bg"],
      },
    ]);
  await ingestEntriesDetailed(db, fakeEmbed, first, "s1", "p", [e]);
  const target = (await db.listDocs("s1", "p")).find((d) =>
    /dist/.test(d.body),
  );
  await db.markSuperseded("s1", target.id, "fix#1");

  const second = async () =>
    JSON.stringify([
      {
        kind: "decision",
        tier: "normal",
        body: "commit the dist folder to the repo so installs need no toolchain at all",
        entities: ["dist"],
      },
      {
        kind: "context",
        tier: "normal",
        body: "background detail",
        entities: ["bg"],
      },
    ]);
  await ingestEntriesDetailed(db, fakeEmbed, second, "s1", "p", [e], {
    force: true,
  });
  const now = await db.docsBySource("s1", "e1");
  const renamed = now.find((d) => /at all/.test(d.body));
  assert.ok(renamed, "the reworded fact has a new id");
  assert.equal(renamed.supersededBy, "fix#1", "and inherits the supersession");
  assert.equal(
    now.find((d) => d.body === "background detail").supersededBy,
    null,
    "an unrelated sibling stays live",
  );
});
