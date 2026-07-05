import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appJwt,
  installationToken,
  b64url,
} from "../dist/gateway/src/github-auth.js";
import { makeEnv, ghFetch, TEST_KEYPAIR } from "./helpers.mjs";

function decodeSegment(seg) {
  return JSON.parse(
    Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
  );
}

test("appJwt produces a verifiable RS256 JWT with iss/iat/exp", async () => {
  const now = 1_800_000_000;
  const jwt = await appJwt("12345", TEST_KEYPAIR.pem, now);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(decodeSegment(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodeSegment(p), {
    iat: now - 60,
    exp: now + 600,
    iss: "12345",
  });
  const sig = Uint8Array.from(
    Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    TEST_KEYPAIR.publicKey,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert.equal(ok, true);
});

test("b64url is unpadded and url-safe", () => {
  assert.equal(b64url("ab?~"), Buffer.from("ab?~").toString("base64url"));
});

test("installationToken exchanges JWT once, then serves from KV cache", async () => {
  const calls = [];
  const fetchImpl = ghFetch(calls, [
    [
      "/app/installations/777/access_tokens",
      () => Response.json({ token: "ghs_test_token" }, { status: 201 }),
    ],
  ]);
  const env = makeEnv(fetchImpl);
  assert.equal(await installationToken(env, 777, fetchImpl), "ghs_test_token");
  assert.equal(await installationToken(env, 777, fetchImpl), "ghs_test_token");
  assert.equal(calls.length, 1); // second hit came from KV
  assert.match(calls[0].init.headers.authorization, /^Bearer eyJ/);
  assert.equal(calls[0].init.method, "POST");
});

test("installationToken throws on non-2xx", async () => {
  const fetchImpl = ghFetch(
    [],
    [["/access_tokens", () => new Response("nope", { status: 401 })]],
  );
  await assert.rejects(
    () => installationToken(makeEnv(fetchImpl), 1, fetchImpl),
    /401/,
  );
});
