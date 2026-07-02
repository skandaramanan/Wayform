import { pathToFileURL } from "node:url";

/**
 * True when the module identified by `importMetaUrl` is the process entry point
 * (i.e. it was spawned directly: `node dist/hook.js`), false when it was merely
 * imported (e.g. by cli.ts). Lets an entrypoint keep a direct-spawn self-run for
 * existing tests while being safely importable by the dispatcher.
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}
