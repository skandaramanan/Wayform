// Two production bugs found on 2026-09-14, after the first post-deploy budget
// reset: re-extracting an entry resurrected what it had superseded, and the
// one-time legacy tree walk never ran once any new write existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { ingestEntriesDetailed } from "../dist/gateway/src/ingest.js";
import { reconcileAll } from "../dist/gateway/src/reindex.js";
import { registerSpaceRepo } from "../dist/gateway/src/tenancy.js";
import { gitBlobSha } from "../dist/gateway/src/github-store.js";
import { EXTRACTOR_VERSION } from "../dist/gateway/src/extract.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";

const SR = {
  space: "s1",
  installationId: 7,
  owner: "o",
  repo: "r",
  branch: "main",
};
const path = (id) => `context/memorylayer/skanda/${id}.md`;
const entry = (id, payload) => ({
  author: "Skanda",
  type: "decision",
  timestamp: "2026-09-13T00:00:00Z",
  id,
  payload,
  file: path(id),
});
const genOf =
  (...bodies) =>
  async () =>
    JSON.stringify(
      bodies.map((body) => ({
        kind: "decision",
        tier: "normal",
        body,
        entities: ["x"],
      })),
    );

test("re-extracting a superseding entry keeps what it replaced superseded", async () => {
  const db = new MemoryIndexDb();
  await ingestEntriesDetailed(db, fakeEmbed, null, "s1", "memorylayer", [
    entry("old", "POST /admin/reindex first thing tomorrow."),
  ]);
  const [oldFact] = await db.listDocs("s1", "memorylayer");

  // The correction supersedes it while its own entry is still one floor fact.
  await ingestEntriesDetailed(
    db,
    fakeEmbed,
    null,
    "s1",
    "memorylayer",
    [entry("fix", "Do not POST /admin/reindex; the cron self-migrates.")],
    { authorSupersedes: [oldFact.id] },
  );
  assert.ok(
    (await db.getDoc("s1", oldFact.id)).supersededBy?.startsWith("fix#"),
  );

  // The retry sweep later splits the correction into new fact ids.
  await ingestEntriesDetailed(
    db,
    fakeEmbed,
    genOf("do not POST /admin/reindex", "the cron self-migrates"),
    "s1",
    "memorylayer",
    [entry("fix", "Do not POST /admin/reindex; the cron self-migrates.")],
    { force: true },
  );
  const pointer = (await db.getDoc("s1", oldFact.id)).supersededBy;
  const live = await db.listDocs("s1", "memorylayer");
  assert.ok(pointer, "the old fact must stay superseded");
  assert.ok(
    live.some((d) => d.id === pointer),
    "and point at a fact that exists",
  );
  assert.ok(!live.some((d) => d.id === oldFact.id));
});

test("re-extracting a superseded entry keeps its new facts superseded", async () => {
  const db = new MemoryIndexDb();
  await ingestEntriesDetailed(db, fakeEmbed, null, "s1", "memorylayer", [
    entry("stale", "A long stale plan."),
  ]);
  for (const d of await db.listDocs("s1", "memorylayer")) {
    await db.markSuperseded("s1", d.id, "newer#fact");
  }
  await ingestEntriesDetailed(
    db,
    fakeEmbed,
    genOf("stale step one", "stale step two"),
    "s1",
    "memorylayer",
    [entry("stale", "A long stale plan.")],
    { force: true },
  );
  assert.deepEqual(await db.listDocs("s1", "memorylayer"), []);
  const facts = await db.docsBySource("s1", "stale");
  assert.equal(facts.length, 2);
  assert.ok(facts.every((d) => d.supersededBy === "newer#fact"));
});

test("the cron walks the tree once per extractor version, even after new writes exist", async () => {
  const calls = [];
  const legacyRaw = `---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-01T00:00:00Z\nid: legacy\nproject: memorylayer\n---\n\n${"x".repeat(900)}\n`;
  const db = new MemoryIndexDb();
  const env = makeEnv(
    ghFetch(calls, [
      [
        "/app/installations/",
        () => Response.json({ token: "t", expires_at: "2099-01-01T00:00:00Z" }),
      ],
      ["/commits/main", () => Response.json({ sha: "headsha" })],
      [
        "/git/trees/main",
        async () =>
          Response.json({
            tree: [
              {
                path: path("legacy"),
                type: "blob",
                sha: await gitBlobSha(legacyRaw),
              },
            ],
          }),
      ],
      [`/contents/${path("legacy")}`, () => new Response(legacyRaw)],
    ]),
    { indexDb: db, embedder: fakeEmbed },
  );
  await registerSpaceRepo(env, SR);
  await db.setLastIndexedSha("s1", "headsha");
  // A legacy floored blob with no ingest_state row…
  await db.upsertDocs([
    {
      id: "legacy#0",
      space: "s1",
      project: "memorylayer",
      kind: "decision",
      tier: "normal",
      body: "x".repeat(900),
      sourceFile: path("legacy"),
      sourceAuthor: "Skanda",
      sourceTs: "2026-07-01T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-07-01T00:00:00Z",
      sourceId: "legacy",
      entities: ["x"],
    },
  ]);
  // …and one fresh write that DOES have a row — which is what hid the
  // legacy blobs from the old "no ingest_state yet" check.
  await db.putIngestState({
    space: "s1",
    sourceFile: path("fresh"),
    digest: "d",
    version: EXTRACTOR_VERSION,
    status: "ok",
    updatedAt: new Date().toISOString(),
  });

  await reconcileAll(env);
  assert.ok(
    calls.some((c) => c.url.includes("/git/trees/")),
    "the tree was walked",
  );
  assert.ok(
    (await db.getIngestStates("s1", [path("legacy")])).has(path("legacy")),
    "the legacy blob now has a row the retry sweep can find",
  );
  assert.equal(await env.ROUTING.get("index-backfill:s1"), EXTRACTOR_VERSION);

  calls.length = 0;
  await reconcileAll(env);
  assert.ok(
    !calls.some((c) => c.url.includes("/git/trees/")),
    "walked once, not every tick",
  );
});
