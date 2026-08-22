import fs from "node:fs";
import path from "node:path";
import { Entry } from "@napi-rs/keyring";

const SERVICE = "wayform-oauth";
const BACKEND_ERROR =
  "Wayform could not access this operating system's credential store. " +
  "Configure Keychain, Secret Service, or Credential Manager and run `wayform login` again.";

export interface CredentialStore {
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): void;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deletePassword(): unknown;
}

export type EntryFactory = (service: string, account: string) => KeyringEntry;

function readFile(file: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeFile(file: string, values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX permission bits.
  }
}

function testFileCredentialStore(file: string): CredentialStore {
  return {
    get(account) {
      return readFile(file)[account] ?? null;
    },
    set(account, secret) {
      const values = readFile(file);
      values[account] = secret;
      writeFile(file, values);
    },
    delete(account) {
      const values = readFile(file);
      delete values[account];
      writeFile(file, values);
    },
  };
}

function credentialError(error: unknown): Error {
  return new Error(BACKEND_ERROR, { cause: error });
}

export function createCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
  entryFactory: EntryFactory = (service, account) =>
    new Entry(service, account),
): CredentialStore {
  const testFile = env.WAYFORM_KEYCHAIN_FILE?.trim();
  if (env.NODE_ENV === "test" && testFile) {
    return testFileCredentialStore(testFile);
  }

  return {
    get(account) {
      try {
        return entryFactory(SERVICE, account).getPassword();
      } catch (error) {
        throw credentialError(error);
      }
    },
    set(account, secret) {
      try {
        entryFactory(SERVICE, account).setPassword(secret);
      } catch (error) {
        throw credentialError(error);
      }
    },
    delete(account) {
      try {
        entryFactory(SERVICE, account).deletePassword();
      } catch (error) {
        throw credentialError(error);
      }
    },
  };
}
