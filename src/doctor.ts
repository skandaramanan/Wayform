import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialStore } from "./credential-store.js";
import { oauthFetch } from "./oauth-session.js";
import {
  defaultProject,
  loadConfig,
  normalizeRepoUrl,
  type Config,
  HOOK_ENV_FILE,
  HOOK_ENV_FILES,
} from "./config.js";

const execFileAsync = promisify(execFile);
const GATEWAY_PROBE_TIMEOUT_MS = 4000;
/** Reachability only — no retrieval, so it should never need the read budget. */
const HEALTH_PROBE_TIMEOUT_MS = 3000;
/** Files that used to carry a member credential. Hook env is URL-only now. */
// Both names: an install from before the rename still has the legacy file.
const SECRET_FILES = [...HOOK_ENV_FILES];

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  status: CheckStatus;
  name: string;
  message: string;
}

export type GitRunner = (
  cwd: string | undefined,
  args: string[],
) => Promise<string>;

interface DoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  config?: Config;
  gitRunner?: GitRunner;
  fetchImpl?: typeof fetch;
  credentialStore?: CredentialStore;
  write?: (line: string) => void;
  setExitCode?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const setExitCode = options.setExitCode ?? true;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const gitRunner = options.gitRunner ?? runGit;
  const results: CheckResult[] = [];

  results.push(checkEnvFile(cwd, options.env ?? process.env));

  let cfg: Config;
  try {
    cfg = options.config ?? loadConfig();
    results.push({
      status: "ok",
      name: "config",
      message: `loaded for ${cfg.author}`,
    });
  } catch (err) {
    results.push({
      status: "fail",
      name: "config",
      message: redactSecrets(err instanceof Error ? err.message : String(err)),
    });
    printResults(results, write);
    if (setExitCode) process.exitCode = 1;
    return 1;
  }

  results.push(...checkSecretPerms(cwd));

  // Hosted (gateway) members have repoUrl="" — the git checks would run
  // against an empty URL and fail a perfectly healthy setup. Probe the
  // gateway instead; run the git checks only when a clone is configured.
  if (cfg.gatewayUrl) {
    results.push(
      await checkGateway(
        cfg,
        cwd,
        options.fetchImpl ?? fetch,
        options.credentialStore,
      ),
    );
  }
  if (cfg.repoUrl) {
    results.push(await checkClone(cfg, gitRunner));
    results.push(await checkRemote(cfg, gitRunner));
    results.push(await checkSync(cfg, gitRunner));
  }
  results.push(checkProject(cwd));

  printResults(results, write);
  const failed = results.some((result) => result.status === "fail");
  if (setExitCode) process.exitCode = failed ? 1 : 0;
  return failed ? 1 : 0;
}

export function checkEnvFile(cwd: string, env: NodeJS.ProcessEnv): CheckResult {
  const file = HOOK_ENV_FILES.map((n) => path.join(cwd, n)).find((p) =>
    fs.existsSync(p),
  );
  if (!file) {
    return {
      status: "fail",
      name: "env file",
      message: `${HOOK_ENV_FILE} is missing`,
    };
  }

  const text = fs.readFileSync(file, "utf8");
  const keys = new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.slice(0, line.indexOf("=")).trim())
      .filter(Boolean),
  );
  const hasKey = (key: string) => keys.has(key) || Boolean(env[key]?.trim());
  // Either prefix satisfies the check: hook env files written before the
  // rename still use MEMORYLAYER_*, and both are honored indefinitely.
  const has = (key: string) =>
    hasKey(key) ||
    (key.startsWith("WAYFORM_") &&
      hasKey(key.replace(/^WAYFORM_/, "MEMORYLAYER_")));
  // Hosted members get a gateway-only env (init --remote writes no
  // CONTEXT_REPO_URL); local members need the repo URL instead.
  const hosted = has("WAYFORM_GATEWAY_URL");
  const required = hosted
    ? ["WAYFORM_GATEWAY_URL"]
    : ["CONTEXT_REPO_URL", "WAYFORM_AUTHOR"];
  const missing = required.filter((key) => !has(key));
  if (missing.length > 0) {
    return {
      status: "fail",
      name: "env file",
      message: `missing ${missing.join(", ")}`,
    };
  }
  return {
    status: "ok",
    name: "env file",
    message: `required keys are present (${hosted ? "hosted" : "local"} mode)`,
  };
}

/**
 * Warn on secret-bearing files readable by other local users. init writes
 * them 0600 (see init-env.ts); a loose copy usually predates that hardening.
 * No-op check on Windows, where POSIX mode bits are not meaningful.
 */
/**
 * Does this hook env file actually hold a credential?
 *
 * The same FILENAME is two different things: `init --remote` writes a
 * credential-free hosted config (its own header says "Safe to commit for
 * teammates"), while local-mode `init` writes CONTEXT_REPO_URL, which can carry
 * a token. Judging by name warned on every fresh clone of a hosted repo about a
 * file with nothing to hide — a warning that is always wrong trains people to
 * ignore the check.
 *
 * Unreadable is treated as sensitive: refusing to answer is not evidence of
 * safety.
 */
function holdsCredential(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return true;
  }
  return /(?:^|\n)\s*(?:MEMORYLAYER|WAYFORM)_GATEWAY_TOKEN\s*=\s*\S/.test(text)
    ? true
    : /(?:mlk_|wfi_)[A-Za-z0-9_-]{20,}/.test(text) ||
        // a context-repo URL with embedded userinfo (https://<token>@host/…)
        /(?:^|\n)\s*CONTEXT_REPO_URL\s*=\s*\S+:\/\/[^@\s/]+@/.test(text);
}

export function checkSecretPerms(cwd: string): CheckResult[] {
  if (process.platform === "win32") return [];
  const loose: string[] = [];
  for (const rel of SECRET_FILES) {
    const file = path.join(cwd, rel);
    if (!fs.existsSync(file)) continue;
    // Judge by CONTENTS, not filename — see holdsCredential().
    if (!holdsCredential(file)) continue;
    if ((fs.statSync(file).mode & 0o077) !== 0) loose.push(rel);
  }
  if (loose.length === 0) {
    return [
      { status: "ok", name: "perms", message: "secret files are owner-only" },
    ];
  }
  return [
    {
      status: "warn",
      name: "perms",
      message: `${loose.join(", ")} readable by other users — run: chmod 600 ${loose.join(" ")}`,
    },
  ];
}

/**
 * Two probes, because one answer cannot carry two questions.
 *
 * `/health` is unauthenticated and constant-cost, so it alone decides
 * REACHABLE. `/mcp/hook/read` is the call the session hook makes, and it runs
 * the whole retrieval path, whose cost is O(corpus) — on a cold isolate a
 * healthy gateway can blow the probe budget. Reporting that as "unreachable"
 * sends you to look at DNS and Cloudflare for a problem that is neither.
 *
 * So: /health fails -> unreachable. /health passes but the read is slow ->
 * warn, and say it is slow. Missing/expired session -> run `wayform login`,
 * never "paste a token".
 */
export async function checkGateway(
  cfg: Config,
  cwd: string,
  fetchImpl: typeof fetch,
  credentialStore?: CredentialStore,
): Promise<CheckResult> {
  if (!cfg.gatewayUrl)
    return {
      status: "fail",
      name: "gateway",
      message: "gateway URL is not configured",
    };
  // Probe 1 — reachability only. Cheap, unauthenticated, no retrieval.
  try {
    const health = await fetchImpl(`${cfg.gatewayUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!health.ok) {
      return {
        status: "fail",
        name: "gateway",
        message: `unreachable: HTTP ${health.status} from ${cfg.gatewayUrl}/health`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "fail",
      name: "gateway",
      message: `unreachable: ${redactSecrets(message)}`,
    };
  }

  // Probe 2 — the authenticated read path. The gateway is known reachable by
  // now, so anything that fails here is auth or read latency, never the network.
  const url = new URL(`${cfg.gatewayUrl}/mcp/hook/read`);
  url.searchParams.set("project", defaultProject(cwd));
  url.searchParams.set("budget", "1");
  try {
    const res = await oauthFetch(
      cfg.gatewayUrl,
      url.toString(),
      { signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS) },
      { fetchImpl, store: credentialStore },
    );
    if (res.ok) {
      return {
        status: "ok",
        name: "gateway",
        message: `reachable (${cfg.gatewayUrl})`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        status: "fail",
        name: "gateway",
        message: "logged-out or expired — run: wayform login",
      };
    }
    return {
      status: "fail",
      name: "gateway",
      message: `unexpected HTTP ${res.status} from ${cfg.gatewayUrl}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/run: wayform login/i.test(message)) {
      return {
        status: "fail",
        name: "gateway",
        message: "not logged in — run: wayform login",
      };
    }
    // Reachability already passed, so a timeout here is a SLOW READ, not a
    // down gateway. Warn rather than fail: the gateway is serving.
    if (/abort|timeout/i.test(message)) {
      return {
        status: "warn",
        name: "gateway",
        message: `reachable, but the read path took over ${GATEWAY_PROBE_TIMEOUT_MS}ms (cold isolate or a large corpus) — retry; if it persists the read path needs prefiltering`,
      };
    }
    return {
      status: "fail",
      name: "gateway",
      message: `read failed: ${redactSecrets(message)}`,
    };
  }
}

export async function checkClone(
  cfg: Config,
  gitRunner: GitRunner,
): Promise<CheckResult> {
  if (!fs.existsSync(path.join(cfg.repoPath, ".git"))) {
    return {
      status: "fail",
      name: "clone",
      message: `clone missing at ${cfg.repoPath}`,
    };
  }

  try {
    const origin = (
      await gitRunner(cfg.repoPath, ["remote", "get-url", "origin"])
    ).trim();
    const matches = normalizeRepoUrl(origin) === normalizeRepoUrl(cfg.repoUrl);
    return matches
      ? {
          status: "ok",
          name: "clone",
          message: `origin matches ${redactSecrets(origin)}`,
        }
      : {
          status: "fail",
          name: "clone",
          message: `origin ${redactSecrets(origin)} does not match configured repo`,
        };
  } catch (err) {
    return {
      status: "fail",
      name: "clone",
      message: redactSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function checkRemote(
  cfg: Config,
  gitRunner: GitRunner,
): Promise<CheckResult> {
  try {
    await gitRunner(undefined, [
      "ls-remote",
      "--exit-code",
      cfg.repoUrl,
      "HEAD",
    ]);
    return {
      status: "ok",
      name: "remote",
      message: `reachable ${redactSecrets(cfg.repoUrl)}`,
    };
  } catch (err) {
    return {
      status: "fail",
      name: "remote",
      message: redactSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function checkSync(
  cfg: Config,
  gitRunner: GitRunner,
): Promise<CheckResult> {
  if (!fs.existsSync(path.join(cfg.repoPath, ".git"))) {
    return {
      status: "warn",
      name: "sync",
      message: "clone missing; run a read or write first",
    };
  }

  try {
    const branch = (
      await gitRunner(cfg.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
    const counts = (
      await gitRunner(cfg.repoPath, [
        "rev-list",
        "--left-right",
        "--count",
        `origin/${branch}...HEAD`,
      ])
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    const [behind = 0, ahead = 0] = counts;
    return {
      status: ahead > 0 ? "warn" : "ok",
      name: "sync",
      message: `${ahead} unpushed commit(s), ${behind} remote commit(s) not pulled`,
    };
  } catch (err) {
    return {
      status: "warn",
      name: "sync",
      message: redactSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
}

export function checkProject(cwd: string): CheckResult {
  return {
    status: "ok",
    name: "project",
    message: `default project is ${defaultProject(cwd)}`,
  };
}

export function redactSecrets(message: string): string {
  return message.replace(/(https?:\/\/)([^@\s/]+)@/g, "$1***@");
}

async function runGit(
  cwd: string | undefined,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function printResults(
  results: CheckResult[],
  write: (line: string) => void,
): void {
  write("Wayform doctor");
  for (const result of results) {
    write(`[${result.status}] ${result.name}: ${result.message}`);
  }
}
