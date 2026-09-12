import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTokenArgs, runToken } from "../dist/token.js";

test("parseTokenArgs only opts into --header", () => {
  assert.deepEqual(parseTokenArgs([]), { header: false });
  assert.deepEqual(parseTokenArgs(["--header"]), { header: true });
  assert.deepEqual(parseTokenArgs(["--other"]), { header: false });
});

test("bare `wayform token` prints the raw token and nothing else", async () => {
  const lines = [];
  await runToken([], {
    log: (m) => lines.push(m),
    getToken: async () => "tok-abc",
  });
  assert.deepEqual(lines, ["tok-abc"]);
});

test("`--header` prints a value usable directly as a curl -H argument", async () => {
  const lines = [];
  await runToken(["--header"], {
    log: (m) => lines.push(m),
    getToken: async () => "tok-abc",
  });
  assert.deepEqual(lines, ["authorization: Bearer tok-abc"]);
});

test("a logged-out member gets the login instruction, not a blank line", async () => {
  const lines = [];
  await assert.rejects(
    () =>
      runToken(["--header"], {
        log: (m) => lines.push(m),
        getToken: async () => {
          throw new Error("Wayform is not logged in — run: wayform login");
        },
      }),
    /wayform login/,
  );
  assert.deepEqual(lines, [], "nothing is printed when there is no token");
});

test("the token is resolved through the session path, so it can refresh", async () => {
  // Reading the keyring directly would print an expired token; going through
  // getValidAccessToken means an expired one is renewed first.
  let askedFor = null;
  await runToken([], {
    log: () => {},
    getToken: async (gatewayUrl) => {
      askedFor = gatewayUrl;
      return "tok";
    },
  });
  assert.match(String(askedFor), /^https?:\/\//);
});
