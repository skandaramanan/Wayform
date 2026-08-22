import {
  createCredentialStore,
  type CredentialStore,
} from "./credential-store.js";

function resolveStore(store?: CredentialStore): CredentialStore {
  return store ?? createCredentialStore();
}

export function keychainGet(
  account: string,
  store?: CredentialStore,
): string | null {
  return resolveStore(store).get(account);
}

export function keychainSet(
  account: string,
  secret: string,
  store?: CredentialStore,
): void {
  resolveStore(store).set(account, secret);
}

export function keychainDelete(account: string, store?: CredentialStore): void {
  resolveStore(store).delete(account);
}

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
  store?: CredentialStore,
): StoredOAuth | null {
  const raw = keychainGet(gatewayAccount(gatewayUrl), store);
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
  store?: CredentialStore,
): void {
  keychainSet(gatewayAccount(gatewayUrl), JSON.stringify(tokens), store);
}
