import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  supersessionCandidates,
  judgePair,
  applySupersession,
  detectWriteConflicts,
  formatWriteResult,
} from "../dist/gateway/src/supersede.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { fakeEmbed, fakeJudge, fakeGenText } from "./helpers.mjs";
import { ingestEntries } from "../dist/gateway/src/ingest.js";

const liveDoc = (
  id,
  body,
  entities = [],
  embedding = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
) => ({
  id,
  space: "s1",
  project: "memorylayer",
  kind: "decision",
  tier: "normal",
  body,
  sourceFile: "f.md",
  sourceAuthor: "A",
  sourceTs: "2026-01-01T00:00:00Z",
  embedding,
  supersededBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  sourceId: id.split("#")[0],
  entities,
});

test("buildJudgePrompt includes both fact bodies", () => {
  const p = buildJudgePrompt(
    { body: "new text", kind: "decision" },
    { id: "o1", body: "old text", kind: "decision" },
  );
  assert.match(p, /new text/);
  assert.match(p, /old text/);
});

test("parseJudgeVerdict accepts valid JSON", () => {
  assert.equal(
    parseJudgeVerdict('{"verdict":"replaces","reason":"direct update"}')
      .verdict,
    "replaces",
  );
});

test("parseJudgeVerdict fail-open on garbage", () => {
  assert.equal(parseJudgeVerdict("not json").verdict, "uncertain");
});

test("supersessionCandidates prefers shared entity tags", () => {
  const newF = liveDoc("n#0", "cursor scoped", ["cursor"]);
  const tagged = liveDoc(
    "t1",
    "cursor fact",
    ["cursor"],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  const untagged = liveDoc(
    "u1",
    "unrelated",
    [],
    [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  const cands = supersessionCandidates([tagged, untagged], newF, 10, 0.5);
  assert.ok(cands.some((d) => d.id === "t1"));
  assert.ok(!cands.some((d) => d.id === "u1"));
});

test("judgePair returns replaces from fake judge", async () => {
  const gen = fakeJudge({
    "old scope": '{"verdict":"replaces","reason":"updated policy"}',
  });
  const r = await judgePair(
    gen,
    { body: "new scope", kind: "decision" },
    { id: "o1", body: "old scope", kind: "decision" },
  );
  assert.equal(r.verdict, "replaces");
});

test("applySupersession auto-links on replaces only", async () => {
  const db = new MemoryIndexDb();
  const emb = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const old = liveDoc("old#0", "project-scoped MCP", ["cursor"], emb);
  const newF = liveDoc("new#0", "MCP is global now", ["cursor"], emb);
  await db.upsertDocs([old, newF]);
  const gen = fakeJudge({
    "project-scoped": '{"verdict":"replaces","reason":"policy change"}',
  });
  await applySupersession(db, gen, "s1", "memorylayer", [newF]);
  assert.equal((await db.getDoc("s1", "old#0"))?.supersededBy, "new#0");
  assert.deepEqual(
    (await db.listDocs("s1")).map((d) => d.id),
    ["new#0"],
  );
});

test("applySupersession does not link on contradicts", async () => {
  const db = new MemoryIndexDb();
  const emb = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const old = liveDoc("old#0", "project-scoped", ["cursor"], emb);
  const newF = liveDoc("new#0", "maybe global", ["cursor"], emb);
  await db.upsertDocs([old, newF]);
  const gen = fakeJudge({
    "project-scoped": '{"verdict":"contradicts","reason":"unclear"}',
  });
  await applySupersession(db, gen, "s1", "memorylayer", [newF]);
  assert.equal((await db.listDocs("s1")).length, 2);
});

test("author supersedes links without judge", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([liveDoc("old#0", "x", ["cursor"])]);
  await applySupersession(
    db,
    null,
    "s1",
    "memorylayer",
    [liveDoc("new#0", "y")],
    {
      authorSupersedes: ["old#0"],
    },
  );
  assert.equal((await db.getDoc("s1", "old#0"))?.supersededBy, "new#0");
});

test("detectWriteConflicts surfaces contradicts", async () => {
  const db = new MemoryIndexDb();
  const [emb] = await fakeEmbed(["MCP is project-scoped"]);
  await db.upsertDocs([
    liveDoc("o1", "MCP is project-scoped", ["cursor"], emb),
  ]);
  const embed = async () => [emb];
  const gen = fakeJudge({
    "project-scoped": '{"verdict":"contradicts","reason":"now claims global"}',
  });
  const hits = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "MCP is global",
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].verdict, "contradicts");
});

test("formatWriteResult appends conflict section", () => {
  const text = formatWriteResult(
    {
      type: "decision",
      author: "A",
      timestamp: "2026-07-10T00:00:00Z",
      file: "f.md",
    },
    "memorylayer",
    [{ factId: "o1", body: "old", reason: "clash", verdict: "contradicts" }],
    ["old#0"],
  );
  assert.match(text, /Possible conflicts/);
  assert.match(text, /Supersedes: old#0/);
});

test("ingestEntries with authorSupersedes marks old facts", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([liveDoc("e0#0", "old fact", ["cursor"])]);
  const gen = fakeGenText({
    "global change": JSON.stringify([
      {
        kind: "decision",
        tier: "normal",
        body: "new fact",
        entities: ["cursor"],
      },
    ]),
  });
  const entry = {
    author: "Skanda",
    type: "decision",
    timestamp: "2026-07-10T00:00:00Z",
    id: "e1",
    payload: "global change",
    file: "context/memorylayer/skanda/e1.md",
  };
  await ingestEntries(db, fakeEmbed, gen, "s1", "memorylayer", [entry], {
    authorSupersedes: ["e0#0"],
  });
  assert.equal((await db.getDoc("s1", "e0#0"))?.supersededBy, "e1#0");
});
