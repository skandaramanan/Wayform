/** In-memory KVStore implementing exactly the surface gateway code uses. */
export class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, typeOrOpts) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    const type = typeof typeOrOpts === "string" ? typeOrOpts : typeOrOpts?.type;
    if (type === "json") return JSON.parse(value);
    return value;
  }
  async put(key, value, _opts) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const names = [...this.map.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const start = cursor ? Number(cursor) : 0;
    const page = names.slice(start, start + limit);
    const next =
      start + limit < names.length ? String(start + limit) : undefined;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: !next,
      cursor: next,
    };
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

/** Env with a FakeKV and the test keypair; pass a mock fetch for GitHub calls.
 *  extra: { indexDb, embedder, WEBHOOK_SECRET, ... } merged onto the env. */
export function makeEnv(githubFetch, extra = {}) {
  const routing = extra.ROUTING ?? new FakeKV();
  return {
    ROUTING: routing,
    OAUTH_KV: routing,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: TEST_KEYPAIR.pem,
    GITHUB_CLIENT_ID: "Iv1.testoauth",
    ADMIN_SECRET: "test-admin-secret",
    githubFetch,
    ...extra,
  };
}

/** Deterministic 16-dim embedding: token-hash bag, so shared vocabulary =>
 *  higher cosine. Good enough to exercise the vector path without a model. */
export async function fakeEmbed(texts) {
  return texts.map((text) => {
    const v = new Array(16).fill(0);
    for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length < 2) continue;
      let h = 0;
      for (const c of tok) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      v[h % 16] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
}

/** Deterministic text-gen seam: returns a JSON fact array driven by the entry
 *  body so extraction tests need no model. Recognizes marker substrings; else
 *  returns a sentinel the parser rejects → the extractor's fail-open floor. */
export function fakeGenText(script = {}) {
  return async (prompt) => {
    for (const [marker, json] of Object.entries(script)) {
      if (prompt.includes(marker)) return json;
    }
    return "__PASSTHROUGH__"; // caller's parser will reject → fail-open floor
  };
}

/** Returns canned judge JSON when the prompt contains a marker substring. */
export function fakeJudge(script = {}) {
  return async (prompt) => {
    for (const [marker, json] of Object.entries(script)) {
      if (prompt.includes(marker)) return json;
    }
    return '{"verdict":"relates","reason":"default"}';
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
