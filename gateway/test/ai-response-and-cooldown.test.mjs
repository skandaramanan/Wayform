// Two causes of the daily budget burn found 2026-09-17: Workers AI returns an
// already-parsed object for clean JSON completions (which every parser choked
// on), and tree walks re-extracted floored entries ignoring the retry cooldown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexDeps } from "../dist/gateway/src/deps.js";
import { extractFactsDetailed } from "../dist/gateway/src/extract.js";
import { judgePair } from "../dist/gateway/src/supersede.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { ingestEntriesDetailed } from "../dist/gateway/src/ingest.js";
import { EXTRACTOR_VERSION } from "../dist/gateway/src/extract.js";
import { FakeKV, fakeEmbed } from "./helpers.mjs";

const entry = {
  author: "A",
  type: "decision",
  timestamp: "2026-09-17T00:00:00Z",
  id: "e1",
  payload: "Session-start injection prefixes a tool-policy playbook.",
  file: "context/memorylayer/a/e1.md",
};

function aiReturning(response) {
  return {
    indexDb: new MemoryIndexDb(),
    ROUTING: new FakeKV(),
    AI: {
      async run(model, input) {
        return input.text ? { data: [[1]] } : { response };
      },
    },
  };
}

test("a clean JSON completion parsed by Workers AI still extracts facts", async () => {
  const { gen } = indexDeps(
    aiReturning([
      {
        kind: "decision",
        tier: "normal",
        body: "Session-start injection prefixes a tool-policy playbook",
        entities: ["session-start"],
      },
    ]),
  );
  const { facts, floored } = await extractFactsDetailed(gen, entry);
  assert.equal(floored, false);
  assert.equal(facts[0].entities[0], "session-start");
});

test("a clean JSON verdict parsed by Workers AI is not downgraded to uncertain", async () => {
  const { gen } = indexDeps(
    aiReturning({ verdict: "replaces", reason: "direct update" }),
  );
  const r = await judgePair(
    gen,
    { body: "new", kind: "decision" },
    { id: "o", body: "old", kind: "decision" },
  );
  assert.equal(r.verdict, "replaces");
});

test("a recently floored entry is not re-extracted by walks or webhooks", async () => {
  const db = new MemoryIndexDb();
  let calls = 0;
  const gen = async () => {
    calls += 1;
    return "not json";
  };
  const digest = "blobsha";
  const state = (updatedAt) => ({
    space: "s1",
    sourceFile: entry.file,
    digest,
    version: EXTRACTOR_VERSION,
    status: "floored",
    updatedAt,
  });
  await db.putIngestState(state(new Date().toISOString()));
  const fresh = await ingestEntriesDetailed(
    db,
    fakeEmbed,
    gen,
    "s1",
    "memorylayer",
    [{ ...entry, digest }],
  );
  assert.equal(
    fresh.skipped,
    1,
    "inside the cooldown only the sweep may retry",
  );
  assert.equal(calls, 0);

  await db.putIngestState(state("2026-01-01T00:00:00Z"));
  await ingestEntriesDetailed(db, fakeEmbed, gen, "s1", "memorylayer", [
    { ...entry, digest },
  ]);
  assert.ok(calls > 0, "past the cooldown it is retried");
});
