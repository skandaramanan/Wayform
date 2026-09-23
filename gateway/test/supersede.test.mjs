import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  supersessionCandidates,
  judgePair,
  applySupersession,
  detectWriteConflicts,
  formatDuplicateResult,
  formatWriteResult,
} from "../dist/gateway/src/supersede.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
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

test("a judge 'replaces' is a suggestion: logged and demoted, never linked", async () => {
  // Auditing 73 production auto-links (2026-09-17) found about half false,
  // with no similarity threshold separating them. A false link hides a true
  // fact; a suggestion only demotes it.
  const db = new MemoryIndexDb();
  const emb = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const old = liveDoc("old#0", "project-scoped MCP", ["cursor"], emb);
  const newF = liveDoc("new#0", "MCP is global now", ["cursor"], emb);
  await db.upsertDocs([old, newF]);
  const gen = fakeJudge({
    "project-scoped": '{"verdict":"replaces","reason":"policy change"}',
  });
  await applySupersession(db, gen, "s1", "memorylayer", [newF]);
  assert.equal((await db.getDoc("s1", "old#0"))?.supersededBy, null);
  assert.equal((await db.listDocs("s1")).length, 2, "both facts stay visible");
  const logged = db.supersessionLogged.find((e) => e.oldFactId === "old#0");
  assert.equal(logged.verdict, "replaces");
  assert.equal(logged.autoLinked, false);
  assert.equal((await db.supersessionSuggestions("s1")).get("old#0"), "new#0");
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
  const { duplicate, conflicts: hits } = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "MCP is global",
  );
  assert.equal(duplicate, null, "log-only default must never block");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].verdict, "contradicts");
});

test("detectWriteConflicts judges at most SYNC_JUDGE_LIMIT candidates on the write path", async () => {
  const db = new MemoryIndexDb();
  const [emb] = await fakeEmbed(["MCP is project-scoped"]);
  // Three live facts all sharing the topic and embedding — all clear the
  // cosine floor, so without a cap all three would hit the LLM judge on the
  // hot write path.
  await db.upsertDocs([
    liveDoc("o1", "MCP is project-scoped one", ["cursor"], emb),
    liveDoc("o2", "MCP is project-scoped two", ["cursor"], emb),
    liveDoc("o3", "MCP is project-scoped three", ["cursor"], emb),
  ]);
  const embed = async () => [emb];
  let calls = 0;
  const gen = async () => {
    calls++;
    return '{"verdict":"contradicts","reason":"conflict"}';
  };
  const { conflicts: hits } = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "MCP is global",
  );
  assert.equal(calls, 2, "judge called at most twice despite 3 candidates");
  assert.equal(hits.length, 2);
});

test("detectWriteConflicts fails open to hits-so-far when the judge exceeds timeoutMs", async () => {
  const db = new MemoryIndexDb();
  const [emb] = await fakeEmbed(["MCP is project-scoped"]);
  await db.upsertDocs([
    liveDoc("o1", "MCP is project-scoped one", ["cursor"], emb),
    liveDoc("o2", "MCP is project-scoped two", ["cursor"], emb),
  ]);
  const embed = async () => [emb];
  const gen = async () => {
    await new Promise((r) => setTimeout(r, 200));
    return '{"verdict":"contradicts","reason":"slow"}';
  };
  const started = Date.now();
  const { conflicts: hits } = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "MCP is global",
    { timeoutMs: 20 },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 150, `returned before judges finished (${elapsed}ms)`);
  assert.equal(hits.length, 0, "no judge completed within the deadline");
});

test("detectWriteConflicts passes the real entry kind to the judge", async () => {
  const db = new MemoryIndexDb();
  const [emb] = await fakeEmbed(["MCP is project-scoped"]);
  await db.upsertDocs([
    liveDoc("o1", "MCP is project-scoped", ["cursor"], emb),
  ]);
  const embed = async () => [emb];
  let seenPrompt = "";
  const gen = async (p) => {
    seenPrompt = p;
    return '{"verdict":"relates","reason":"x"}';
  };
  await detectWriteConflicts(db, embed, gen, "s1", "memorylayer", "some note", {
    kind: "context",
  });
  assert.match(seenPrompt, /NEW \(context\)/);
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
  assert.match(text, /may replace or contradict/);
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
  // Ids are content-derived, so assert PROVENANCE (which entry superseded it)
  // rather than a literal id. Pinning the literal is what made a stored
  // reference silently repoint at different text when re-extraction renumbered.
  const superseder = (await db.getDoc("s1", "e0#0"))?.supersededBy;
  assert.ok(
    superseder?.startsWith("e1#"),
    `expected a fact from entry e1, got ${superseder}`,
  );
  const live = await db.listDocs("s1", "memorylayer");
  assert.ok(
    live.some((d) => d.id === superseder && d.body === "new fact"),
    "the superseding id must resolve to the fact that actually replaced it",
  );
});

// --- near-duplicate write gate (log-only rollout), 2026-07-17 ---

test("dup gate blocks an exact duplicate when enforcing, without calling the judge", async () => {
  const db = new MemoryIndexDb();
  const [emb] = await fakeEmbed(["MCP is project-scoped"]);
  await db.upsertDocs([
    liveDoc("o1", "MCP is project-scoped", ["cursor"], emb),
  ]);
  const embed = async () => [emb]; // identical vector => cosine 1.0
  let judgeCalls = 0;
  const gen = async () => {
    judgeCalls++;
    return '{"verdict":"relates","reason":"x"}';
  };
  const { duplicate, conflicts } = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "MCP is project-scoped",
    { enforceDup: true },
  );
  assert.ok(duplicate, "exact duplicate must be reported");
  assert.equal(duplicate.factId, "o1");
  assert.ok(duplicate.score >= 0.95);
  assert.equal(conflicts.length, 0);
  assert.equal(judgeCalls, 0, "a blocked duplicate skips the judge");
  const dupLog = db.supersessionLogged.find((e) => e.verdict === "duplicate");
  assert.ok(dupLog, "duplicate verdict logged for audit");
  assert.equal(dupLog.newFactId, "(blocked)");
});

test("dup gate in log-only mode records the score but never blocks", async () => {
  const db = new MemoryIndexDb();
  const [emb] = await fakeEmbed(["MCP is project-scoped"]);
  await db.upsertDocs([
    liveDoc("o1", "MCP is project-scoped", ["cursor"], emb),
  ]);
  const embed = async () => [emb];
  const gen = async () => '{"verdict":"relates","reason":"x"}';
  const { duplicate } = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "MCP is project-scoped",
  );
  assert.equal(duplicate, null, "log-only must not block");
  const dupLog = db.supersessionLogged.find((e) => e.verdict === "duplicate");
  assert.ok(dupLog, "over-floor score still logged for calibration");
  assert.match(dupLog.reason, /log-only/);
});

test("dup gate lets a below-floor paraphrase through even when enforcing", async () => {
  const db = new MemoryIndexDb();
  // cosine([1,0,...],[0.8,0.6,0,...]) = 0.8 — same topic, not a duplicate
  const stored = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const incoming = [0.8, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  await db.upsertDocs([liveDoc("o1", "MCP is project-scoped", [], stored)]);
  const embed = async () => [incoming];
  const gen = async () => '{"verdict":"relates","reason":"x"}';
  const { duplicate } = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "MCP scoping is per project",
    { enforceDup: true },
  );
  assert.equal(duplicate, null);
});

test("dup gate is bypassed by dedupe:false (author supersedes) even at cosine 1.0", async () => {
  const db = new MemoryIndexDb();
  const [emb] = await fakeEmbed(["budget is 5k"]);
  await db.upsertDocs([liveDoc("o1", "budget is 5k", [], emb)]);
  const embed = async () => [emb];
  const gen = async () => '{"verdict":"relates","reason":"x"}';
  const { duplicate } = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "budget is 6k",
    { dedupe: false, enforceDup: true },
  );
  assert.equal(duplicate, null, "explicit supersedes must never be gated");
});

test("dup gate fails open to storing when the embedder throws", async () => {
  const db = new MemoryIndexDb();
  const [emb] = await fakeEmbed(["x"]);
  await db.upsertDocs([liveDoc("o1", "x", [], emb)]);
  const embed = async () => {
    throw new Error("AI down");
  };
  const gen = async () => '{"verdict":"relates","reason":"x"}';
  const check = await detectWriteConflicts(
    db,
    embed,
    gen,
    "s1",
    "memorylayer",
    "x",
    { enforceDup: true },
  );
  assert.deepEqual(check, { duplicate: null, conflicts: [] });
});

test("formatDuplicateResult names the fact and the supersedes escape hatch", () => {
  const text = formatDuplicateResult(
    { factId: "o1", body: "MCP is project-scoped", score: 0.97 },
    "memorylayer",
  );
  assert.match(text, /not re-recorded/);
  assert.match(text, /o1/);
  assert.match(text, /similarity 0\.97/);
  assert.match(text, /supersedes: \["o1"\]/);
});

test("plan docs are never supersession candidates, conflicts or duplicates", async () => {
  const [emb] = await fakeEmbed(["Plan #1 [active] Move plans to the ledger"]);
  const plan = {
    ...liveDoc(
      "plan:p1234567",
      "Plan #1 [active] Move plans to the ledger",
      ["plans"],
      emb,
    ),
    kind: "plan",
    sourceId: "plan:p1234567",
  };
  const fact = { ...plan, id: "new#0", kind: "decision", sourceId: "new" };
  assert.deepEqual(supersessionCandidates([plan], fact, 10, 0), []);

  const db = new MemoryIndexDb();
  await db.upsertDocs([plan]);
  let judged = 0;
  const check = await detectWriteConflicts(
    db,
    async () => [emb],
    async () => {
      judged += 1;
      return '{"verdict":"replaces","reason":"same"}';
    },
    "s1",
    "memorylayer",
    "Plan #1 [active] Move plans to the ledger",
    { enforceDup: true },
  );
  assert.equal(check.duplicate, null);
  assert.deepEqual(check.conflicts, []);
  assert.equal(judged, 0);
});

// ---------------------------------------------------------------------------
// The supersession judge: chat-mode calls, and a parser that survives a model
// that keeps talking. Measured 2026-09-22 on 18 real production pairs.
// ---------------------------------------------------------------------------
import {
  parseJudgeVerdict as parseVerdict,
  judgePair as judge,
  JUDGE_SYSTEM,
} from "../dist/gateway/src/supersede.js";

test("a verdict followed by more output still parses", async () => {
  // Real shape of a 2026-09-22 production failure: a good object, then the
  // model carried on continuing the prompt until the 160-token cap. The old
  // parser spanned the first "{" to the LAST "}" and got an unparseable span.
  const raw =
    '{"verdict":"replaces","reason":"NEW updates OLD."}\n' +
    'NEW (status): PR #80 merged\nOLD (context): {"not":"json"';
  assert.equal(parseVerdict(raw).verdict, "replaces");
  assert.equal(parseVerdict(raw).reason, "NEW updates OLD.");
});

test("a brace inside a reason string does not end the object", () => {
  const raw =
    '{"verdict":"relates","reason":"the literal {\\"a\\":1} appears"}';
  assert.equal(parseVerdict(raw).verdict, "relates");
});

test("preamble before the JSON is still fine, and junk alone is parse-failed", () => {
  assert.equal(
    parseVerdict('Sure. {"verdict":"uncertain","reason":"x"}').verdict,
    "uncertain",
  );
  const bad = parseVerdict("NEW (status): the model never emitted JSON");
  assert.equal(bad.verdict, "uncertain");
  assert.equal(bad.reason, "parse-failed");
});

test("the judge is called as a chat, with the rules as the system message", async () => {
  const seen = [];
  const gen = async (prompt, opts) => {
    seen.push({ prompt, opts });
    return '{"verdict":"relates","reason":"different events"}';
  };
  const r = await judge(
    gen,
    { body: "PR #80 merged", kind: "status" },
    { id: "a#1", body: "PR #56 merged", kind: "context" },
  );
  assert.equal(r.verdict, "relates");
  assert.equal(seen.length, 1);
  // The rules go in the system message; the user message is ONLY the pair —
  // a raw completion of the rules-plus-pair document is what the model used to
  // continue instead of answering.
  assert.equal(seen[0].opts.system, JUDGE_SYSTEM);
  assert.equal(seen[0].opts.purpose, "judge");
  assert.match(
    seen[0].prompt,
    /^NEW \(status\): PR #80 merged\nOLD \(context, id=a#1\): PR #56 merged$/,
  );
  assert.doesNotMatch(seen[0].prompt, /Verdict rules/);
});

test("a retired fact stops suggesting that a live fact is outdated", async () => {
  // Found 2026-09-23 by dogfooding: a paraphrase written to verify the judge
  // made the live CANON fact it paraphrased render "⚠ possibly outdated", and
  // retiring the paraphrase did not clear it — the suggestion query required
  // only that the suggesting fact EXIST, not that it still be live.
  const db = new MemoryIndexDb();
  const emb = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const canon = liveDoc("canon#0", "gateway ships by npm run deploy", [], emb);
  const para = liveDoc(
    "para#0",
    "shipping the gateway runs npm run deploy",
    [],
    emb,
  );
  await db.upsertDocs([canon, para]);
  await db.logSupersession({
    space: "s1",
    project: "memorylayer",
    newFactId: "para#0",
    oldFactId: "canon#0",
    verdict: "replaces",
    autoLinked: false,
    reason: "judge",
    ts: new Date().toISOString(),
  });
  assert.equal(
    (await db.supersessionSuggestions("s1")).get("canon#0"),
    "para#0",
    "while both are live the suggestion stands",
  );
  await db.markSuperseded("s1", "para#0", "canon#0");
  assert.equal(
    (await db.supersessionSuggestions("s1")).get("canon#0"),
    undefined,
    "once the suggesting fact is retired the warning must go with it",
  );
});
