import { spawnSync } from "node:child_process";

/**
 * Subcommands that load the full corpus (with bodies) in-process. On a
 * multi-GB vault they exceed Node's default old-space and die with a V8
 * heap-limit FATAL before printing anything. The same ceiling the dashboard's
 * vault workers use (8GB) is applied by re-exec'ing the CLI under a raised
 * heap. Commands that only need metadata are bounded at the loader instead
 * (omitBodies / bodyMaxChars) and are NOT listed here.
 */
const HEAVY_COMMANDS = new Set(["consolidate", "procedure", "refresh", "rebless"]);

const REEXEC_ENV = "MEMORY_HEAVY_REEXEC";
const HEAP_MB = 8192;

export function shouldReexecHeavy(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[REEXEC_ENV] === "1") return false;
  if (env["NODE_OPTIONS"]?.includes("--max-old-space-size")) return false;
  const subcommand = argv[2];
  return subcommand !== undefined && HEAVY_COMMANDS.has(subcommand);
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
