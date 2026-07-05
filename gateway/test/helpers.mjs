/** In-memory KVStore implementing exactly the surface gateway code uses. */
export class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value, _opts) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

/** A 2048-bit RSA test keypair, PKCS#8 PEM + public key for verification. */
async function genKeypair() {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const b64 = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    publicKey: kp.publicKey,
  };
}

export const TEST_KEYPAIR = await genKeypair();

/** Env with a FakeKV and the test keypair; pass a mock fetch for GitHub calls. */
export function makeEnv(githubFetch) {
  return {
    ROUTING: new FakeKV(),
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: TEST_KEYPAIR.pem,
    ADMIN_SECRET: "test-admin-secret",
    githubFetch,
  };
}

/** Mock fetch: records calls, answers by first matching URL substring. */
export function ghFetch(calls, routes) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, respond] of routes) {
      if (String(url).includes(pattern)) return respond(String(url), init);
    }
    return new Response(JSON.stringify({ message: "no mock route" }), {
      status: 404,
    });
  };
}
