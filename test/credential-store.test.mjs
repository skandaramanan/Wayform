import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// node:crypto, not the global: globalThis.crypto is Node 19+, and this
// package supports Node >=18 (CI tests it).
import { randomUUID } from "node:crypto";

test("credential store uses a plaintext file only in explicit test mode", async () => {
  const { createCredentialStore } = await import("../dist/credential-store.js");
  const file = path.join(
    os.tmpdir(),
    `wayform-credential-store-${randomUUID()}.json`,
  );
  const native = new Map();
  const entryFactory = (_service, account) => ({
    getPassword: () => native.get(account) ?? null,
    setPassword: (secret) => native.set(account, secret),
    deletePassword: () => native.delete(account),
  });

  try {
    const testStore = createCredentialStore(
      { NODE_ENV: "test", WAYFORM_KEYCHAIN_FILE: file },
      entryFactory,
    );
    testStore.set("gw", "test-secret");
    assert.equal(testStore.get("gw"), "test-secret");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const productionStore = createCredentialStore(
      { WAYFORM_KEYCHAIN_FILE: `${file}.production` },
      entryFactory,
    );
    productionStore.set("gw", "native-secret");
    assert.equal(productionStore.get("gw"), "native-secret");
    assert.equal(fs.existsSync(`${file}.production`), false);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.production`, { force: true });
  }
});

test("native credential errors become actionable Wayform errors", async () => {
  const { createCredentialStore } = await import("../dist/credential-store.js");
  const store = createCredentialStore({}, () => ({
    getPassword() {
      throw new Error("native backend unavailable");
    },
    setPassword() {
      throw new Error("native backend unavailable");
    },
    deletePassword() {
      throw new Error("native backend unavailable");
    },
  }));

  assert.throws(
    () => store.get("gw"),
    /Keychain, Secret Service, or Credential Manager/,
  );
});
