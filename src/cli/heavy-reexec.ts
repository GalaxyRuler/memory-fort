import { spawnSync } from "node:child_process";

/**
 * Subcommands that load the full corpus (with bodies) in-process. On a
 * multi-GB vault they exceed Node's default old-space and die with a V8
 * heap-limit FATAL before printing anything. The same ceiling the dashboard's
 * vault workers use (8GB) is applied by re-exec'ing the CLI under a raised
 * heap. Commands that only need metadata are bounded at the loader instead
 * (omitBodies / bodyMaxChars) and are NOT listed here.
 */
const HEAVY_COMMAND_PATHS = new Set([
  "consolidate",
  "procedure",
  "refresh",
  "rebless",
  // eval-retrieval loads a full all-scope corpus (src/eval/retrieval/runner.ts).
  "eval-retrieval",
  // provider embedding maintenance loads one (reindex) or two (rebless)
  // complete corpora (src/cli/commands/provider.ts).
  "provider reindex-embeddings",
  "provider rebless-embeddings",
]);

const REEXEC_ENV = "MEMORY_HEAVY_REEXEC";
const HEAP_MB = 8192;

export function shouldReexecHeavy(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[REEXEC_ENV] === "1") return false;
  if (env["NODE_OPTIONS"]?.includes("--max-old-space-size")) return false;
  // Match the command PATH (first two non-flag tokens), not just argv[2]:
  // the heavy provider commands are subcommands, and flags may precede the
  // command name.
  const words = argv.slice(2).filter((token) => !token.startsWith("-")).slice(0, 2);
  if (words.length === 0) return false;
  return HEAVY_COMMAND_PATHS.has(words.join(" ")) || HEAVY_COMMAND_PATHS.has(words[0]!);
}

/** Re-exec the CLI under a raised heap; returns the child's exit code. */
export function reexecHeavy(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, argv[1]!, ...argv.slice(2)],
    { stdio: "inherit", env: { ...env, [REEXEC_ENV]: "1" } },
  );
  return result.status ?? 1;
}
