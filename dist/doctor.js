import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultProject, loadConfig, normalizeRepoUrl, } from "./config.js";
const execFileAsync = promisify(execFile);
const REQUIRED_ENV_KEYS = ["CONTEXT_REPO_URL", "MEMORYLAYER_AUTHOR"];
export async function runDoctor(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const setExitCode = options.setExitCode ?? true;
    const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    const gitRunner = options.gitRunner ?? runGit;
    const results = [];
    results.push(checkEnvFile(cwd, options.env ?? process.env));
    let cfg;
    try {
        cfg = options.config ?? loadConfig();
        results.push({
            status: "ok",
            name: "config",
            message: `loaded for ${cfg.author}`,
        });
    }
    catch (err) {
        results.push({
            status: "fail",
            name: "config",
            message: redactSecrets(err instanceof Error ? err.message : String(err)),
        });
        printResults(results, write);
        if (setExitCode)
            process.exitCode = 1;
        return 1;
    }
    results.push(await checkClone(cfg, gitRunner));
    results.push(await checkRemote(cfg, gitRunner));
    results.push(await checkSync(cfg, gitRunner));
    results.push(checkProject(cwd));
    printResults(results, write);
    const failed = results.some((result) => result.status === "fail");
    if (setExitCode)
        process.exitCode = failed ? 1 : 0;
    return failed ? 1 : 0;
}
export function checkEnvFile(cwd, env) {
    const file = path.join(cwd, ".memorylayer-hook.env");
    if (!fs.existsSync(file)) {
        return {
            status: "fail",
            name: "env file",
            message: ".memorylayer-hook.env is missing",
        };
    }
    const text = fs.readFileSync(file, "utf8");
    const keys = new Set(text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.slice(0, line.indexOf("=")).trim())
        .filter(Boolean));
    const missing = REQUIRED_ENV_KEYS.filter((key) => !keys.has(key) && !env[key]?.trim());
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
        message: "required keys are present",
    };
}
export async function checkClone(cfg, gitRunner) {
    if (!fs.existsSync(path.join(cfg.repoPath, ".git"))) {
        return {
            status: "fail",
            name: "clone",
            message: `clone missing at ${cfg.repoPath}`,
        };
    }
    try {
        const origin = (await gitRunner(cfg.repoPath, ["remote", "get-url", "origin"])).trim();
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
    }
    catch (err) {
        return {
            status: "fail",
            name: "clone",
            message: redactSecrets(err instanceof Error ? err.message : String(err)),
        };
    }
}
export async function checkRemote(cfg, gitRunner) {
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
    }
    catch (err) {
        return {
            status: "fail",
            name: "remote",
            message: redactSecrets(err instanceof Error ? err.message : String(err)),
        };
    }
}
export async function checkSync(cfg, gitRunner) {
    if (!fs.existsSync(path.join(cfg.repoPath, ".git"))) {
        return {
            status: "warn",
            name: "sync",
            message: "clone missing; run a read or write first",
        };
    }
    try {
        const branch = (await gitRunner(cfg.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        const counts = (await gitRunner(cfg.repoPath, [
            "rev-list",
            "--left-right",
            "--count",
            `origin/${branch}...HEAD`,
        ]))
            .trim()
            .split(/\s+/)
            .map(Number);
        const [behind = 0, ahead = 0] = counts;
        return {
            status: ahead > 0 ? "warn" : "ok",
            name: "sync",
            message: `${ahead} unpushed commit(s), ${behind} remote commit(s) not pulled`,
        };
    }
    catch (err) {
        return {
            status: "warn",
            name: "sync",
            message: redactSecrets(err instanceof Error ? err.message : String(err)),
        };
    }
}
export function checkProject(cwd) {
    return {
        status: "ok",
        name: "project",
        message: `default project is ${defaultProject(cwd)}`,
    };
}
export function redactSecrets(message) {
    return message.replace(/(https?:\/\/)([^@\s/]+)@/g, "$1***@");
}
async function runGit(cwd, args) {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
}
function printResults(results, write) {
    write("Wayform doctor");
    for (const result of results) {
        write(`[${result.status}] ${result.name}: ${result.message}`);
    }
}
//# sourceMappingURL=doctor.js.map