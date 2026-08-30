import type { CredentialStore } from "./credential-store.js";
import {
  loadStoredOAuth,
  saveStoredOAuth,
  type StoredOAuth,
} from "./keychain.js";

const REFRESH_SKEW_MS = 60_000;
const LOGIN_REQUIRED = "Wayform login expired — run: wayform login";

export interface OAuthSessionOptions {
  store?: CredentialStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

const refreshes = new Map<string, Promise<string>>();

function requireLogin(): never {
  throw new Error(LOGIN_REQUIRED);
}

function isTerminalRefreshFailure(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

function concurrentSession(
  gatewayUrl: string,
  stored: StoredOAuth,
  store: CredentialStore | undefined,
): StoredOAuth | null {
  const latest = loadStoredOAuth(gatewayUrl, store);
  if (
    latest?.access_token &&
    (latest.access_token !== stored.access_token ||
      latest.refresh_token !== stored.refresh_token)
  ) {
    return latest;
  }
  return null;
}

async function refreshAccessToken(
  gatewayUrl: string,
  stored: StoredOAuth,
  options: OAuthSessionOptions,
): Promise<string> {
  const now = options.now ?? Date.now;
  if (!stored.refresh_token || !stored.client_id || !stored.token_endpoint) {
    return requireLogin();
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(stored.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refresh_token,
        client_id: stored.client_id,
        resource: stored.resource,
      }).toString(),
      signal: options.signal,
    });
  } catch (error) {
    throw new Error("Wayform could not refresh the OAuth session", {
      cause: error,
    });
  }
  if (!response.ok) {
    if (isTerminalRefreshFailure(response.status)) {
      const concurrent = concurrentSession(gatewayUrl, stored, options.store);
      if (concurrent) return concurrent.access_token;
      return requireLogin();
    }
    throw new Error(`Wayform OAuth refresh failed (${response.status})`);
  }

  const body = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.access_token !== "string" || !body.access_token) {
    const concurrent = concurrentSession(gatewayUrl, stored, options.store);
    if (concurrent) return concurrent.access_token;
    return requireLogin();
  }
  const expiresIn =
    typeof body.expires_in === "number" &&
    Number.isFinite(body.expires_in) &&
    body.expires_in > 0
      ? body.expires_in
      : 3600;
  const refreshed: StoredOAuth = {
    ...stored,
    access_token: body.access_token,
    refresh_token:
      typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : stored.refresh_token,
    expires_at: now() + expiresIn * 1000,
  };
  saveStoredOAuth(gatewayUrl, refreshed, options.store);
  return refreshed.access_token;
}

export async function getValidAccessToken(
  gatewayUrl: string,
  options: OAuthSessionOptions = {},
): Promise<string> {
  const stored = loadStoredOAuth(gatewayUrl, options.store);
  if (!stored?.access_token) {
    throw new Error("Wayform is not logged in — run: wayform login");
  }

  const now = options.now ?? Date.now;
  if (!options.forceRefresh && stored.expires_at > now() + REFRESH_SKEW_MS) {
    return stored.access_token;
  }

  const active = refreshes.get(gatewayUrl);
  if (active) return active;
  const refresh = refreshAccessToken(gatewayUrl, stored, options);
  refreshes.set(gatewayUrl, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshes.get(gatewayUrl) === refresh) refreshes.delete(gatewayUrl);
  }
}

function withAuthorization(
  init: RequestInit | undefined,
  accessToken: string,
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  return { ...init, headers };
}

export async function oauthFetch(
  gatewayUrl: string,
  input: string | URL | Request,
  init: RequestInit = {},
  options: OAuthSessionOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sessionOptions: OAuthSessionOptions = {
    ...options,
    signal: options.signal ?? init.signal ?? undefined,
  };
  const accessToken = await getValidAccessToken(gatewayUrl, sessionOptions);
  const firstInput = input instanceof Request ? input.clone() : input;
  const first = await fetchImpl(
    firstInput,
    withAuthorization(init, accessToken),
  );
  if (first.status !== 401) return first;

  const refreshed = await getValidAccessToken(gatewayUrl, {
    ...sessionOptions,
    forceRefresh: true,
  });
  const retryInput = input instanceof Request ? input.clone() : input;
  return fetchImpl(retryInput, withAuthorization(init, refreshed));
}
