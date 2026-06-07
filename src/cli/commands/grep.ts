import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { rawDir, wikiDir } from "../../storage/paths.js";

export type GrepScope = "raw" | "wiki" | "both";

export interface GrepOptions {
  pattern: string;
  scope?: GrepScope;
  contextLines?: number;
  /** For tests — inject a spawn fn. */
  spawn?: (
    cmd: string,
    args: string[],
    opts: { encoding: "utf-8" },
  ) => SpawnSyncReturns<string>;
  /** For tests — override stdout/stderr writers. */
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface GrepResult {
  exitCode: 0 | 1 | 2;
  argsUsed: string[];
  dirsSearched: string[];
}

/**
 * Memory CLI's tier-1 retrieval: a thin ripgrep wrapper over
 * markdown files in ~/.memory/raw/ and/or ~/.memory/wiki/.
 * Exit code: 0 = matches, 1 = none, 2 = error.
 */
export function runGrep(opts: GrepOptions): GrepResult {
  const scope: GrepScope = opts.scope ?? "both";
  const ctx = opts.contextLines ?? 2;
  const spawnFn = opts.spawn ?? ((cmd, args, spawnOpts) => spawnSync(cmd, args, spawnOpts));
  const writeOut = opts.stdout ?? ((text) => process.stdout.write(text));
  const writeErr = opts.stderr ?? ((text) => process.stderr.write(text));

  const dirs: string[] = [];
  const dirLabels: string[] = [];
  if (scope === "raw" || scope === "both") {
    const rawRoot = rawDir().replace(/[\\/][0-9-]+$/, "");
    if (existsSync(rawRoot)) {
      dirs.push(rawRoot);
      dirLabels.push("raw/");
    }
  }
  if (scope === "wiki" || scope === "both") {
    if (existsSync(wikiDir())) {
      dirs.push(wikiDir());
      dirLabels.push("wiki/");
    }
  }

  if (dirs.length === 0) {
    writeErr(`memory grep: no directories to search (scope: ${scope})\n`);
    return { exitCode: 2, argsUsed: [], dirsSearched: [] };
  }

  const rgArgs = [
    "--type",
    "md",
    "-n",
    "-C",
    String(ctx),
    "--color",
    "never",
    "--",
    opts.pattern,
    ...dirs,
  ];

  const result = spawnFn("rg", rgArgs, { encoding: "utf-8" });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      writeErr("memory grep: ripgrep ('rg') not found on PATH. Install ripgrep and retry.\n");
    } else {
      writeErr(`memory grep: ${result.error.message}\n`);
    }
    return { exitCode: 2, argsUsed: rgArgs, dirsSearched: dirs };
  }

  if (result.stdout) writeOut(result.stdout);
  if (result.stderr) writeErr(result.stderr);

  const rawExit = result.status ?? 2;
  const exitCode: 0 | 1 | 2 = rawExit === 0 ? 0 : rawExit === 1 ? 1 : 2;
  if (exitCode === 1 && !result.stdout && !result.stderr) {
    writeErr(`No matches for ${JSON.stringify(opts.pattern)} in ${dirLabels.join(" + ")}.\n`);
  }
  return { exitCode, argsUsed: rgArgs, dirsSearched: dirs };
}
