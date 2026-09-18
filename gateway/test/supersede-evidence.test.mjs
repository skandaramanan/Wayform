// 2026-09-18: supersession that is automatic AND correct. The writing agent
// confirms replacements (supersede_facts); the background judge must quote
// its evidence from the new entry before it may link anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReplacement,
  applySupersession,
  detectWriteConflicts,
  formatWriteResult,
} from "../dist/gateway/src/supersede.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv, ghFetch, fakeEmbed, seedGithubMember } from "./helpers.mjs";

const emb = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const fact = (id, body, extra = {}) => ({
  id,
  space: "s1",
  project: "p",
  kind: "decision",
  tier: "normal",
  body,
  sourceFile: `context/p/a/${id.split("#")[0]}.md`,
  sourceAuthor: "A",
  sourceTs: "2026-09-01T00:00:00Z",
  embedding: emb,
  supersededBy: null,
  createdAt: "2026-09-01T00:00:00Z",
  sourceId: id.split("#")[0],
  entities: ["invite"],
  ...extra,
});
const entryText =
  "Shipped today. The invite-code /join feature is LIVE in production and the design doc is archived.";

test("parseReplacement accepts only a quote that is really in the entry", () => {
  const ok = parseReplacement(
    '{"obsolete": true, "evidence": "The invite-code /join feature is LIVE in production"}',
    entryText,
  );
  assert.equal(ok.replaces, true);
  assert.equal(
    parseReplacement(
      '{"obsolete": true, "evidence": "The invite feature was rewritten in Rust"}',
      entryText,
    ).replaces,
    false,
    "an invented quote proves nothing",
  );
  assert.equal(
    parseReplacement('{"obsolete": false, "evidence": ""}', entryText).replaces,
    false,
  );
  assert.equal(
    parseReplacement('{"obsolete": true, "evidence": "LIVE"}', entryText)
      .replaces,
    false,
    "a fragment too short to prove anything",
  );
});

test("the evidence judge links only with a verified quote, and never backwards in time", async () => {
  const run = async (judgeOut, entryDate) => {
    const db = new MemoryIndexDb();
    const old = fact("old#1", "Invite-code /join design APPROVED");
    const fresh = fact("new#1", "invite-code /join feature is LIVE", {
      sourceTs: entryDate,
    });
    await db.upsertDocs([old, fresh]);
    await applySupersession(db, async () => judgeOut, "s1", "p", [fresh], {
      entry: { text: entryText, date: entryDate },
      evidenceJudge: true,
    });
    return (await db.getDoc("s1", "old#1")).supersededBy;
  };
  const proof =
    '{"obsolete": true, "evidence": "The invite-code /join feature is LIVE in production"}';
  assert.equal(await run(proof, "2026-09-18T00:00:00Z"), "new#1");
  assert.equal(
    await run(
      '{"obsolete": true, "evidence": "made up"}',
      "2026-09-18T00:00:00Z",
    ),
    null,
  );
  assert.equal(
    await run(proof, "2026-08-01T00:00:00Z"),
    null,
    "an older entry cannot retire a newer fact",
  );
});

test("the write result lists 'replaces' candidates and asks the agent to confirm", async () => {
  const db = new MemoryIndexDb();
  const [e] = await fakeEmbed(["invite code join design approved"]);
  await db.upsertDocs([
    fact("old#1", "invite code join design approved", { embedding: e }),
  ]);
  const check = await detectWriteConflicts(
    db,
    async () => [e],
    async () => '{"verdict":"replaces","reason":"status moved to live"}',
    "s1",
    "p",
    "invite code join is live",
  );
  assert.equal(check.conflicts[0].verdict, "replaces");
  const text = formatWriteResult(
    {
      type: "decision",
      author: "A",
      timestamp: "2026-09-18T00:00:00Z",
      file: "f.md",
      id: "abcd1234",
    },
    "p",
    check.conflicts,
    [],
  );
  assert.match(text, /old#1/);
  assert.match(text, /supersede_facts/);
  assert.match(text, /replaced_by_entry = "abcd1234"/);
});

async function mcpEnv(indexDb) {
  const env = makeEnv(
    ghFetch(
      [],
      [
        [
          "/app/installations/777/access_tokens",
          () => Response.json({ token: "ghs_a" }, { status: 201 }),
        ],
      ],
    ),
    { indexDb, embedder: fakeEmbed },
  );
  await seedGithubMember(env, {
    space: "s1",
    installationId: 777,
    owner: "acme",
    repo: "mem",
    author: "Ada",
    authorEmail: "ada@acme.io",
    githubId: 101,
    githubLogin: "ada",
    role: "admin",
  });
  env.oauthProps = { githubId: 101, githubLogin: "ada" };
  return env;
}
const call = (args) =>
  new Request("https://gw.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "supersede_facts", arguments: args },
    }),
  });

test("supersede_facts links confirmed facts to the new entry's fact", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    fact("old#1", "design approved"),
    fact("new1#a", "feature is live"),
  ]);
  const env = await mcpEnv(db);
  const res = await handleRequest(
    call({ fact_ids: ["old#1", "missing#9"], replaced_by_entry: "new1" }),
    env,
  );
  const text = (await res.json()).result.content[0].text;
  assert.match(text, /Marked 1 fact/);
  assert.match(text, /missing#9/);
  assert.equal((await db.getDoc("s1", "old#1")).supersededBy, "new1#a");
  const log = db.supersessionLogged.at(-1);
  assert.equal(log.reason, "author-supersedes");
});

test("supersede_facts before the entry is indexed hides the fact now and attaches later", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([fact("old#1", "design approved")]);
  const env = await mcpEnv(db);
  await handleRequest(
    call({ fact_ids: ["old#1"], replaced_by_entry: "late1" }),
    env,
  );
  assert.equal((await db.getDoc("s1", "old#1")).supersededBy, "late1#entry");
  assert.equal((await db.listDocs("s1")).length, 0, "hidden immediately");

  await db.upsertDocs([fact("late1#x", "feature is live")]);
  await db.repairDanglingSupersession("s1");
  assert.equal((await db.getDoc("s1", "old#1")).supersededBy, "late1#x");
});
