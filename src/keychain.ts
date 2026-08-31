import {
  createCredentialStore,
  type CredentialStore,
} from "./credential-store.js";

export interface StoredOAuth {
  client_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  token_endpoint: string;
  resource: string;
}

export function gatewayAccount(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/, "");
}

export function loadStoredOAuth(
  gatewayUrl: string,
  store: CredentialStore = createCredentialStore(),
): StoredOAuth | null {
  const raw = store.get(gatewayAccount(gatewayUrl));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredOAuth;
  } catch {
    return null;
  }
}

export function saveStoredOAuth(
  gatewayUrl: string,
  tokens: StoredOAuth,
  store: CredentialStore = createCredentialStore(),
): void {
  store.set(gatewayAccount(gatewayUrl), JSON.stringify(tokens));
}
