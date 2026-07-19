import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Minimal set of dist/hooks stubs so install materializeRuntimeScripts can succeed in unit tests. */
export const DEFAULT_HOOK_STUBS = [
  "session-start.mjs",
  "session-end.mjs",
  "prompt-submit.mjs",
  "post-tool-use.mjs",
  "pre-compact.mjs",
  "mcp-server.mjs",
  "opencode-event.mjs",
] as const;

/**
 * Create `<repoDir>/dist/hooks/*.mjs` stub entrypoints and a package.json so
 * installers that materialize vault launchers can run without a full build.
 */
export async function seedBuiltHooks(
  repoDir: string,
  hookFiles: readonly string[] = DEFAULT_HOOK_STUBS,
): Promise<string> {
  const hooksDir = join(repoDir, "dist", "hooks");
  await mkdir(hooksDir, { recursive: true });
  await writeFile(join(repoDir, "package.json"), "{}\n");
  for (const name of hookFiles) {
    await writeFile(join(hooksDir, name), `// stub ${name}\n`);
  }
  return hooksDir;
}
