import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { saveStoredOAuth } from "./keychain.js";
import type { CredentialStore } from "./credential-store.js";

export const DEFAULT_GATEWAY_URL =
  "https://memorylayer-gateway.memory-layer.workers.dev";
export const LOGIN_TIMEOUT_MS = 11 * 60 * 1000;

export interface LoginDeps {
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => void;
  listen?: (handler: http.RequestListener) => Promise<{
    port: number;
    close: () => void;
  }>;
  log?: (msg: string) => void;
  credentialStore?: CredentialStore;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function defaultListen(
  handler: http.RequestListener,
): Promise<{ port: number; close: () => void }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("login listener failed");
  }
  return { port: addr.port, close: () => server.close() };
}

function defaultOpen(url: string): void {
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    }
  } catch {
    // printed for the user to open by hand
  }
}

/**
 * Localhost PKCE against the hosted gateway. Tokens go to the OS keychain
 * (or WAYFORM_KEYCHAIN_FILE in tests) and are never printed.
 */
export async function runLogin(
  args: string[],
  deps: LoginDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((m) => console.log(m));
  const gwFlag = args.indexOf("--gateway");
  const gatewayUrl = (
    (gwFlag >= 0 ? args[gwFlag + 1] : undefined) ??
    process.env.MEMORYLAYER_GATEWAY_URL ??
    DEFAULT_GATEWAY_URL
  ).replace(/\/+$/, "");

  const { verifier, challenge } = pkce();
  const oauthState = b64url(randomBytes(16));
  let settle!: (code: string) => void;
  let fail!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const timeout = setTimeout(
    () => fail(new Error("login timed out waiting for the browser")),
    LOGIN_TIMEOUT_MS,
  );

  const listen = deps.listen ?? defaultListen;
  const listener = await listen((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><title>Wayform</title><p>You can close this tab and return to the terminal.</p>",
      );
      clearTimeout(timeout);
      listener.close();
      if (returnedState !== oauthState) {
        fail(new Error("authorization state mismatch"));
      } else if (err) fail(new Error(`authorization failed: ${err}`));
      else if (!code) fail(new Error("authorization missing code"));
      else settle(code);
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });

  const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
  try {
    const reg = await fetchImpl(`${gatewayUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "wayform-cli",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    if (!reg.ok) {
      throw new Error(`client registration failed (${reg.status})`);
    }
    const client = (await reg.json()) as { client_id: string };
    const authorize = new URL(`${gatewayUrl}/authorize`);
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", oauthState);
    const resource = `${gatewayUrl}/mcp`;
    authorize.searchParams.set("resource", resource);
    log("Open this URL to authorize Wayform with GitHub:");
    log(`  ${authorize.href}`);
    (deps.openUrl ?? defaultOpen)(authorize.href);

    const code = await codePromise;
    const tokenRes = await fetchImpl(`${gatewayUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource,
      }).toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(`token exchange failed (${tokenRes.status})`);
    }
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokens.access_token) {
      throw new Error("token response missing access_token");
    }
    saveStoredOAuth(
      gatewayUrl,
      {
        client_id: client.client_id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        token_endpoint: `${gatewayUrl}/oauth/token`,
        resource,
      },
      deps.credentialStore,
    );
    log(
      "Logged in. Restart your agent, then ask it to record a test decision.",
    );
  } catch (err) {
    clearTimeout(timeout);
    listener.close();
    throw err;
  }
}
