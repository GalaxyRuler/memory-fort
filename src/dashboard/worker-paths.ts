import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a dashboard worker `.mjs` path that works regardless of how the
 * caller was bundled. tsdown inlines the dashboard code into BOTH the
 * standalone `dist/dashboard/server.mjs` entry AND the `dist/cli.mjs` /
 * `dist/electron-main.mjs` entries, so a spawning helper's `import.meta.url`
 * may sit at `dist/` (cli/electron) or `dist/dashboard/` (server). The worker
 * entries always emit to `dist/dashboard/`. Try the sibling first, then a
 * `dashboard/` subdir, and pick the path that exists. Falls back to the sibling
 * candidate so a genuinely missing worker surfaces a clear spawn error.
 */
export function resolveWorkerPath(importMetaUrl: string, workerFileName: string): string {
  const here = dirname(fileURLToPath(importMetaUrl));
  const candidates = [join(here, workerFileName), join(here, "dashboard", workerFileName)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
