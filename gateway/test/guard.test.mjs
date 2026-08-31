import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAction, GUARD_BUDGET_TOKENS } from "../dist/gateway/src/guard.js";

function doc(id, body) {
  return {
    id,
    space: "s1",
    project: "memorylayer",
    kind: "decision",
    tier: "normal",
    body,
    sourceFile: `context/memorylayer/skanda/${id}.md`,
    sourceAuthor: "Skanda",
    sourceTs: "2026-07-12T11:00:00Z",
    embedding: [],
    supersededBy: null,
    createdAt: "2026-07-12T11:00:00Z",
    sourceId: id,
    entities: [],
  };
}

/** Minimal IndexDb surface retrieve() touches, seeded with one live doc. */
function fakeDb(docs) {
  return {
    queryScan: async () => ({
      embeddings: docs.map((d) => ({ id: d.id, embedding: [1, 0] })),
      entitiesByDoc: new Map(),
      tokenMatchIds: docs.map((d) => d.id),
      total: docs.length,
    }),
    getDocsByIds: async (_space, ids) => docs.filter((d) => ids.includes(d.id)),
    feedbackPenalties: async () => new Map(),
    logRetrieval: async () => {},
  };
}

const FACT = doc("pg-fact", "We ruled out a second datastore; Postgres is not being added.");

test("contradicts verdict asks and names the fact", async () => {
  const out = await checkAction(
    {
      db: fakeDb([FACT]),
      embed: async (texts) => texts.map(() => [1, 0]),
      gen: async () =>
        '{"verdict":"contradicts","reason":"The team ruled out a second datastore."}',
    },
    { space: "s1", project: "memorylayer", action: "Edit: add Postgres to docker-compose" },
  );
  assert.equal(out.decision, "ask");
  assert.deepEqual(out.factIds, ["pg-fact"]);
  assert.match(out.reason, /second datastore/);
});

test("non-contradicting verdicts allow", async () => {
  for (const verdict of ["replaces", "relates", "uncertain"]) {
    const out = await checkAction(
      {
        db: fakeDb([FACT]),
        embed: async (texts) => texts.map(() => [1, 0]),
        gen: async () => `{"verdict":"${verdict}","reason":"x"}`,
      },
      { space: "s1", project: "memorylayer", action: "Edit: add Postgres" },
    );
    assert.equal(out.decision, "allow", verdict);
  }
});

test("no retrieval hits allows without calling the judge", async () => {
  let judged = false;
  const out = await checkAction(
    {
      db: fakeDb([]),
      embed: async (texts) => texts.map(() => [1, 0]),
      gen: async () => {
        judged = true;
        return "{}";
      },
    },
    { space: "s1", project: "memorylayer", action: "Edit: rename a variable" },
  );
  assert.equal(out.decision, "allow");
  assert.equal(judged, false);
});

test("a throwing judge fails open to allow", async () => {
  const out = await checkAction(
    {
      db: fakeDb([FACT]),
      embed: async (texts) => texts.map(() => [1, 0]),
      gen: async () => {
        throw new Error("neuron budget exhausted for today");
      },
    },
    { space: "s1", project: "memorylayer", action: "Edit: add Postgres" },
  );
  assert.equal(out.decision, "allow");
});

test("a null gen allows without judging", async () => {
  const out = await checkAction(
    { db: fakeDb([FACT]), embed: async (t) => t.map(() => [1, 0]), gen: null },
    { space: "s1", project: "memorylayer", action: "Edit: add Postgres" },
  );
  assert.equal(out.decision, "allow");
});

test("guard budget stays small enough to bound judge calls", () => {
  assert.ok(GUARD_BUDGET_TOKENS <= 600);
});
