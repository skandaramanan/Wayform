// Neuron + time efficiency of the index plane (2026-09-13): content is never
// extracted twice, rebuilds never wipe, the cron catches up incrementally, and
// the budget counter tracks what calls really cost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import {
  ingestEntriesDetailed,
  ingestFiles,
  reindexSpace,
} from "../dist/gateway/src/ingest.js";
import { reconcileAll } from "../dist/gateway/src/reindex.js";
import { registerSpaceRepo } from "../dist/gateway/src/tenancy.js";
import { gitBlobSha } from "../dist/gateway/src/github-store.js";
import { EXTRACTOR_VERSION } from "../dist/gateway/src/extract.js";
import {
  applySupersession,
  ASYNC_JUDGE_LIMIT,
} from "../dist/gateway/src/supersede.js";
import {
  adjustNeurons,
  DAILY_NEURON_BUDGET,
} from "../dist/gateway/src/neuron-budget.js";
import {
  indexDeps,
  neuronsFor,
  JUDGE_MAX_TOKENS,
  EXTRACT_MAX_TOKENS,
} from "../dist/gateway/src/deps.js";
import { handleRequest } from "../dist/gateway/src/router.js";
import {
  makeEnv,
  ghFetch,
  fakeEmbed,
  FakeKV,
  seedGithubMember,
} from "./helpers.mjs";

const SR = {
  space: "s1",
  installationId: 7,
  owner: "o",
  repo: "r",
  branch: "main",
};
const TOKEN = [
  "/app/installations/",
  () => Response.json({ token: "t", expires_at: "2099-01-01T00:00:00Z" }),
];
const path = (id) => `context/memorylayer/skanda/${id}.md`;
const md = (id, body) =>
  `---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-04T00:00:00Z\nid: ${id}\nproject: memorylayer\n---\n\n${body}\n`;
const entry = (id, payload, extra = {}) => ({
  author: "Skanda",
  type: "decision",
  timestamp: "2026-07-04T00:00:00Z",
  id,
  payload,
  file: path(id),
  ...extra,
});
const oneFact = (body) =>
  JSON.stringify([{ kind: "decision", tier: "normal", body, entities: ["x"] }]);
const today = () => `neuron-budget:${new Date().toISOString().slice(0, 10)}`;

function countingGen(response) {
  const gen = async (prompt, opts) => {
    gen.calls.push({ prompt, opts });
    return response;
  };
  gen.calls = [];
  return gen;
}
const extractCalls = (gen) =>
  gen.calls.filter((c) => c.opts?.purpose === "extract").length;

function doc(id, sourceFile, body, extra = {}) {
  return {
    id,
    space: "s1",
    project: "memorylayer",
    kind: "decision",
    tier: "normal",
    body,
    sourceFile,
    sourceAuthor: "Skanda",
    sourceTs: "2026-07-04T00:00:00Z",
    embedding: [],
    supersededBy: null,
    createdAt: "2026-07-04T00:00:00Z",
    sourceId: id.split("#")[0],
    entities: ["x"],
    ...extra,
  };
}

test("an entry is extracted once — its own push webhook skips it", async () => {
  // Every write_context used to be extracted and judged twice: inline, then
  // again when the push webhook for the commit it had just made arrived.
  const db = new MemoryIndexDb();
  const gen = countingGen(oneFact("we chose D1"));
  const raw = md("e1", "We chose D1 for the index.");
  const digest = await gitBlobSha(raw);
  const first = await ingestEntriesDetailed(
    db,
    fakeEmbed,
    gen,
    "s1",
    "memorylayer",
    [entry("e1", "We chose D1 for the index.", { digest })],
  );
  assert.equal(first.count, 1);
  assert.equal(extractCalls(gen), 1);

  const env = makeEnv(
    ghFetch([], [TOKEN, [`/contents/${path("e1")}`, () => new Response(raw)]]),
  );
  const second = await ingestFiles(
    env,
    db,
    fakeEmbed,
    gen,
    SR,
    [path("e1")],
    "pushsha",
    env.githubFetch,
  );
  assert.equal(second.skipped, 1);
  assert.equal(extractCalls(gen), 1, "no second extraction");
  assert.equal(await db.getLastIndexedSha("s1"), "pushsha");
});

test("writer-split facts are indexed as given, with no model call", async () => {
  const db = new MemoryIndexDb();
  const gen = countingGen("[]");
  const facts = [
    { kind: "decision", body: "Ingest skips unchanged ledger files." },
    {
      kind: "constraint",
      tier: "canon",
      body: "Never wipe the index on a sha mismatch.",
      entities: ["reindex"],
    },
  ];
  const out = await ingestEntriesDetailed(
    db,
    fakeEmbed,
    gen,
    "s1",
    "memorylayer",
    [entry("e2", "A long prose record of the same two points.", { facts })],
  );
  assert.equal(out.count, 2);
  assert.equal(out.floored, 0);
  assert.equal(gen.calls.length, 0, "no extraction, and no sibling judging");
  const docs = await db.listDocs("s1", "memorylayer");
  assert.deepEqual(
    docs.map((d) => d.body).sort(),
    facts.map((f) => f.body).sort(),
  );
  assert.ok(
    docs.every((d) => d.entities.length > 0),
    "untagged facts get tags",
  );
  assert.equal(
    docs.find((d) => d.tier === "canon")?.body,
    "Never wipe the index on a sha mismatch.",
  );
});

test("a floored entry is recorded, left alone without a model, and re-extracted with one", async () => {
  const db = new MemoryIndexDb();
  const e = entry("e3", "Some decision text.");
  const a = await ingestEntriesDetailed(
    db,
    fakeEmbed,
    null,
    "s1",
    "memorylayer",
    [e],
  );
  assert.equal(a.floored, 1);
  const again = await ingestEntriesDetailed(
    db,
    fakeEmbed,
    null,
    "s1",
    "memorylayer",
    [e],
  );
  assert.equal(
    again.skipped,
    1,
    "without a model there is nothing better to do",
  );

  // A floored entry is only retried once its cooldown has passed.
  const st0 = (await db.getIngestStates("s1", [e.file])).get(e.file);
  await db.putIngestState({ ...st0, updatedAt: "2026-01-01T00:00:00Z" });
  const gen = countingGen(oneFact("an extracted fact"));
  const b = await ingestEntriesDetailed(
    db,
    fakeEmbed,
    gen,
    "s1",
    "memorylayer",
    [e],
  );
  assert.equal(b.floored, 0);
  assert.deepEqual(
    (await db.listDocs("s1", "memorylayer")).map((d) => d.body),
    ["an extracted fact"],
  );
  const st = (await db.getIngestStates("s1", [e.file])).get(e.file);
  assert.equal(st.status, "ok");
  assert.equal(st.version, EXTRACTOR_VERSION);
});

test("re-extracting identical facts reuses their vectors and keeps them superseded", async () => {
  const db = new MemoryIndexDb();
  const embedded = [];
  const embed = async (texts) => {
    embedded.push(...texts);
    return fakeEmbed(texts);
  };
  const gen = countingGen(
    JSON.stringify([
      { kind: "decision", tier: "normal", body: "fact A", entities: ["a"] },
      { kind: "decision", tier: "normal", body: "fact B", entities: ["b"] },
    ]),
  );
  const e = entry("e4", "text");
  await ingestEntriesDetailed(db, embed, gen, "s1", "memorylayer", [e]);
  assert.equal(embedded.length, 2);
  const a = (await db.listDocs("s1", "memorylayer")).find(
    (d) => d.body === "fact A",
  );
  await db.markSuperseded("s1", a.id, "other#fact");

  await ingestEntriesDetailed(db, embed, gen, "s1", "memorylayer", [e], {
    force: true,
  });
  assert.equal(embedded.length, 2, "no embedding call for unchanged facts");
  assert.equal(
    (await db.getDoc("s1", a.id)).supersededBy,
    "other#fact",
    "re-ingest must not resurrect a superseded fact",
  );
});

test("a budget stop leaves the indexed sha behind so the tail is retried, not lost", async () => {
  const kv = new FakeKV();
  await kv.put(today(), String(DAILY_NEURON_BUDGET));
  const env = makeEnv(
    ghFetch(
      [],
      [TOKEN, [`/contents/${path("e5")}`, () => new Response(md("e5", "x"))]],
    ),
    { ROUTING: kv },
  );
  const db = new MemoryIndexDb();
  const gen = countingGen(oneFact("f"));
  const out = await ingestFiles(
    env,
    db,
    fakeEmbed,
    gen,
    SR,
    [path("e5")],
    "pushsha",
    env.githubFetch,
  );
  assert.equal(out.stopped, true);
  assert.equal(gen.calls.length, 0);
  assert.equal(await db.getLastIndexedSha("s1"), null);
});

test("files removed upstream leave the index", async () => {
  const db = new MemoryIndexDb();
  await ingestEntriesDetailed(db, fakeEmbed, null, "s1", "memorylayer", [
    entry("gone", "old"),
  ]);
  const env = makeEnv(ghFetch([], []));
  await ingestFiles(env, db, fakeEmbed, null, SR, [], "sha2", env.githubFetch, {
    removed: [path("gone")],
  });
  assert.equal((await db.listDocs("s1")).length, 0);
  assert.equal((await db.getIngestStates("s1", [path("gone")])).size, 0);
});

function treeEnv(files, calls, extra = {}) {
  return makeEnv(
    ghFetch(calls, [
      TOKEN,
      ["/commits/main", () => Response.json({ sha: "headsha" })],
      [
        "/git/trees/main",
        async () =>
          Response.json({
            tree: await Promise.all(
              files.map(async (f) => ({
                path: f.path,
                type: "blob",
                sha: await gitBlobSha(f.raw),
              })),
            ),
          }),
      ],
      ...files.map((f) => [`/contents/${f.path}`, () => new Response(f.raw)]),
    ]),
    extra,
  );
}

test("a full pass fetches only files whose blob sha changed — and never wipes", async () => {
  const calls = [];
  const files = [
    { path: path("a"), raw: md("a", "A") },
    { path: path("b"), raw: md("b", "B") },
  ];
  const env = treeEnv(files, calls);
  const db = new MemoryIndexDb();
  await reindexSpace(env, db, fakeEmbed, null, SR, env.githubFetch);
  assert.equal(calls.filter((c) => c.url.includes("/contents/")).length, 2);

  calls.length = 0;
  const again = await reindexSpace(
    env,
    db,
    fakeEmbed,
    null,
    SR,
    env.githubFetch,
  );
  assert.equal(calls.filter((c) => c.url.includes("/contents/")).length, 0);
  assert.equal(again.skipped, 2);
  assert.equal((await db.listDocs("s1")).length, 2, "nothing was wiped");
});

test("entries indexed before ingest_state are adopted without a fetch when they look extracted", async () => {
  const calls = [];
  const files = [
    { path: path("a"), raw: md("a", "A") },
    { path: path("b"), raw: md("b", "B") },
  ];
  const env = treeEnv(files, calls);
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    doc("a#1", path("a"), "atomic one"),
    doc("a#2", path("a"), "atomic two"),
    doc("b#1", path("b"), "x".repeat(900)), // a whole-entry floor
  ]);
  await reindexSpace(env, db, fakeEmbed, null, SR, env.githubFetch);
  const fetched = calls.filter((c) => c.url.includes("/contents/"));
  assert.equal(fetched.length, 1, "only the floored entry is fetched");
  assert.match(fetched[0].url, /b\.md/);
  assert.equal(
    (await db.getIngestStates("s1", [path("a")])).get(path("a")).status,
    "ok",
  );
});

test("the cron catches up through the compare API — no tree listing, no full pass", async () => {
  const calls = [];
  const db = new MemoryIndexDb();
  const env = makeEnv(
    ghFetch(calls, [
      TOKEN,
      ["/commits/main", () => Response.json({ sha: "headsha" })],
      [
        "/compare/basesha...headsha",
        () =>
          Response.json({
            files: [
              { filename: path("n1"), status: "added" },
              { filename: path("old"), status: "removed" },
            ],
          }),
      ],
      [`/contents/${path("n1")}`, () => new Response(md("n1", "new decision"))],
    ]),
    { indexDb: db, embedder: fakeEmbed },
  );
  await registerSpaceRepo(env, SR);
  await ingestEntriesDetailed(db, fakeEmbed, null, "s1", "memorylayer", [
    entry("old", "old decision"),
  ]);
  await db.setLastIndexedSha("s1", "basesha");
  await env.ROUTING.put("index-backfill:s1", EXTRACTOR_VERSION);

  await reconcileAll(env);
  assert.deepEqual(
    (await db.listDocs("s1")).map((d) => d.body),
    ["new decision"],
  );
  assert.ok(!calls.some((c) => c.url.includes("/git/trees/")));
  assert.equal(await db.getLastIndexedSha("s1"), "headsha");
});

test("a cron tick with no neuron budget left does no model work", async () => {
  const kv = new FakeKV();
  await kv.put(today(), String(DAILY_NEURON_BUDGET));
  const db = new MemoryIndexDb();
  const gen = countingGen(oneFact("f"));
  const env = treeEnv([{ path: path("a"), raw: md("a", "A") }], [], {
    ROUTING: kv,
    indexDb: db,
    embedder: fakeEmbed,
    genText: gen,
  });
  await registerSpaceRepo(env, SR);
  await reconcileAll(env);
  assert.equal(gen.calls.length, 0);
  assert.equal((await db.listDocs("s1")).length, 0);
});

test("the cron retries a floored entry once its cooldown passes, not every tick", async () => {
  const db = new MemoryIndexDb();
  const raw = md("f1", "decision text");
  const gen = countingGen(oneFact("extracted"));
  const env = makeEnv(
    ghFetch(
      [],
      [
        TOKEN,
        ["/commits/main", () => Response.json({ sha: "headsha" })],
        [`/contents/${path("f1")}`, () => new Response(raw)],
      ],
    ),
    { indexDb: db, embedder: fakeEmbed, genText: gen },
  );
  await registerSpaceRepo(env, SR);
  await db.setLastIndexedSha("s1", "headsha");
  await env.ROUTING.put("index-backfill:s1", EXTRACTOR_VERSION);
  await db.upsertDocs([doc("f1#1", path("f1"), "decision text")]);
  const floored = {
    space: "s1",
    sourceFile: path("f1"),
    digest: await gitBlobSha(raw),
    version: EXTRACTOR_VERSION,
    status: "floored",
    updatedAt: new Date().toISOString(),
  };
  await db.putIngestState(floored);

  await reconcileAll(env);
  assert.equal(extractCalls(gen), 0, "floored moments ago: not yet");

  await db.putIngestState({ ...floored, updatedAt: "2026-01-01T00:00:00Z" });
  await reconcileAll(env);
  assert.equal(extractCalls(gen), 1);
  assert.deepEqual(
    (await db.listDocs("s1")).map((d) => d.body),
    ["extracted"],
  );
  assert.equal(
    (await db.getIngestStates("s1", [path("f1")])).get(path("f1")).status,
    "ok",
  );
});

test("async judging is capped per entry and never judges an entry against itself", async () => {
  const db = new MemoryIndexDb();
  const emb = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const olds = Array.from({ length: 10 }, (_, i) =>
    doc(`o${i}#1`, path(`o${i}`), `old fact ${i}`, {
      entities: ["topic"],
      embedding: emb,
    }),
  );
  const fresh = [1, 2, 3].map((i) =>
    doc(`n#${i}`, path("n"), `new fact ${i}`, {
      entities: ["topic"],
      embedding: emb,
    }),
  );
  await db.upsertDocs([...olds, ...fresh]);
  const gen = countingGen('{"verdict":"relates","reason":"x"}');
  await applySupersession(db, gen, "s1", "memorylayer", fresh);
  assert.ok(gen.calls.length > 0);
  assert.ok(
    gen.calls.length <= ASYNC_JUDGE_LIMIT,
    `${gen.calls.length} judge calls for one entry`,
  );
  assert.ok(
    gen.calls.every((c) => !/id=n#/.test(c.prompt)),
    "a sibling fact is never the OLD side",
  );
  assert.ok(gen.calls.every((c) => c.opts?.purpose === "judge"));
});

test("neuron reservations settle against the tokens the model actually used", async () => {
  const kv = new FakeKV();
  const env = {
    indexDb: new MemoryIndexDb(),
    ROUTING: kv,
    AI: {
      async run(model, input) {
        if (input.text) return { data: [[1]] };
        this.seen = input;
        return {
          response: '{"verdict":"relates","reason":"x"}',
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        };
      },
    },
  };
  const deps = indexDeps(env);
  await deps.gen("judge this pair", { purpose: "judge" });
  assert.equal(env.AI.seen.max_tokens, JUDGE_MAX_TOKENS);
  assert.equal(Number(await kv.get(today())), neuronsFor(100, 10));

  await deps.gen("extract this entry");
  assert.equal(env.AI.seen.max_tokens, EXTRACT_MAX_TOKENS);
  assert.equal(Number(await kv.get(today())), neuronsFor(100, 10) * 2);
});

test("adjustNeurons never drives the counter below zero", async () => {
  const kv = new FakeKV();
  await kv.put(today(), "3");
  await adjustNeurons({ ROUTING: kv }, -10);
  assert.equal(await kv.get(today()), "0");
});

test("write_context with facts indexes them without extraction and persists them in the ledger", async () => {
  const indexDb = new MemoryIndexDb();
  const calls = [];
  const gen = countingGen("[]");
  const env = makeEnv(
    ghFetch(calls, [
      [
        "/app/installations/777/access_tokens",
        () => Response.json({ token: "ghs_a" }, { status: 201 }),
      ],
      ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
    ]),
    { indexDb, embedder: fakeEmbed, genText: gen },
  );
  await seedGithubMember(env, {
    space: "team-a",
    installationId: 777,
    owner: "acme",
    repo: "team-a-memory",
    author: "Ada",
    authorEmail: "ada@acme.io",
    githubId: 101,
    githubLogin: "ada",
    role: "admin",
  });
  env.oauthProps = { githubId: 101, githubLogin: "ada" };
  const fact =
    "Reindex never wipes on a sha mismatch, because a wipe re-extracts every entry.";
  await handleRequest(
    new Request("https://gw.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "write_context",
          arguments: {
            project: "memorylayer",
            payload: "We stopped wiping the index. It cost days of budget.",
            facts: [{ kind: "decision", body: fact }],
          },
        },
      }),
    }),
    env,
  );
  const docs = await indexDb.listDocs("team-a", "memorylayer");
  assert.deepEqual(
    docs.map((d) => d.body),
    [fact],
  );
  assert.equal(extractCalls(gen), 0);
  const put = calls.find((c) => c.init.method === "PUT");
  const content = Buffer.from(
    JSON.parse(put.init.body).content,
    "base64",
  ).toString("utf8");
  assert.match(
    content,
    /^facts: \[/m,
    "facts are persisted for every re-index",
  );
});

test("an entry is recorded ok once its facts are written, even if judging never finishes", async () => {
  // Production 2026-09-18: two webhook entries were fully indexed but stuck
  // `pending` for an hour — the Worker was cut off mid-judge, and the status
  // was only written after judging. Health went red, and the cron would have
  // re-extracted them.
  const db = new MemoryIndexDb();
  const [vec] = await fakeEmbed(["Never deploy the gateway on Fridays"]);
  await db.upsertDocs([
    doc("old#1", path("old"), "Deploy the gateway on Fridays", {
      embedding: vec,
    }),
  ]);
  const hang = new Promise(() => {});
  let judging = 0;
  const gen = async (_prompt, opts) => {
    if (opts?.purpose !== "judge")
      return oneFact("Never deploy the gateway on Fridays");
    judging += 1;
    return hang;
  };
  void ingestEntriesDetailed(db, fakeEmbed, gen, "s1", "memorylayer", [
    entry("e9", "Never deploy the gateway on Fridays."),
  ]);
  await new Promise((r) => setTimeout(r, 50));
  const st = (await db.getIngestStates("s1", [path("e9")])).get(path("e9"));
  assert.ok(judging > 0, "the test must reach the judge");
  assert.equal(st?.status, "ok");
  assert.equal((await db.idsBySource("s1", "e9")).length, 1);
});

test("a full pass prunes vanished ledger entries but never plan docs", async () => {
  const db = new MemoryIndexDb();
  await ingestEntriesDetailed(db, fakeEmbed, null, "s1", "memorylayer", [
    entry("gone", "old"),
  ]);
  await db.replaceBySource("s1", "plan:p1234567", [
    doc(
      "plan:p1234567",
      "plans/memorylayer/p1234567",
      "Plan #1 [draft] T\n\nb",
      {
        kind: "plan",
        sourceId: "plan:p1234567",
      },
    ),
  ]);
  const env = treeEnv([{ path: path("a"), raw: md("a", "A") }], []);
  await reindexSpace(env, db, fakeEmbed, null, SR, env.githubFetch);
  const ids = (await db.listDocs("s1")).map((d) => d.id);
  assert.ok(ids.includes("plan:p1234567"), "plan doc survived the prune");
  assert.ok(!ids.some((id) => id.startsWith("gone#")), "vanished entry pruned");
});
