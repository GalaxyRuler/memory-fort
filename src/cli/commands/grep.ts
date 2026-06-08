import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rawDir, wikiDir } from "../../storage/paths.js";

export type GrepScope = "raw" | "wiki" | "both";
export const DEFAULT_GREP_LIMIT = 500;

export interface GrepChildProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface GrepOptions {
  pattern: string;
  scope?: GrepScope;
  contextLines?: number;
  limit?: number;
  /** For tests — inject a spawn fn. */
  spawn?: (
    cmd: string,
    args: string[],
    opts: { stdio: ["ignore", "pipe", "pipe"] },
  ) => GrepChildProcess;
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
export async function runGrep(opts: GrepOptions): Promise<GrepResult> {
  const scope: GrepScope = opts.scope ?? "both";
  const ctx = opts.contextLines ?? 2;
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_GREP_LIMIT));
  const spawnFn = opts.spawn ?? ((cmd, args, spawnOpts) => spawn(cmd, args, spawnOpts));
  const writeOut = opts.stdout ?? ((text) => process.stdout.write(text));
  const writeErr = opts.stderr ?? ((text) => process.stderr.write(text));

  const dirs: string[] = [];
  if (scope === "raw" || scope === "both") {
    const rawRoot = rawDir().replace(/[\\/][0-9-]+$/, "");
    if (existsSync(rawRoot)) dirs.push(rawRoot);
  }
  if (scope === "wiki" || scope === "both") {
    if (existsSync(wikiDir())) dirs.push(wikiDir());
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

  const child = spawnFn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdoutRemainder = "";
  let emittedLines = 0;
  let truncated = false;
  let settled = false;

  const finish = (result: GrepResult, resolve: (value: GrepResult) => void): void => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  const writeLine = (line: string): void => {
    if (truncated) return;
    if (emittedLines >= limit) {
      truncated = true;
      writeOut(`# truncated at ${limit} results\n`);
      child.kill();
      return;
    }
    writeOut(line);
    emittedLines += 1;
  };

  const flushStdout = (): void => {
    if (stdoutRemainder.length === 0 || truncated) return;
    writeLine(stdoutRemainder);
    stdoutRemainder = "";
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (truncated) return;
    stdoutRemainder += chunk.toString();
    let newlineIndex = stdoutRemainder.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutRemainder.slice(0, newlineIndex + 1);
      stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
      writeLine(line);
      if (truncated) {
        stdoutRemainder = "";
        return;
      }
      newlineIndex = stdoutRemainder.indexOf("\n");
    }
  });
  child.stdout.on("end", flushStdout);
  child.stderr.on("data", (chunk: Buffer | string) => {
    writeErr(chunk.toString());
  });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        writeErr("memory grep: ripgrep ('rg') not found on PATH. Install ripgrep and retry.\n");
      } else {
        writeErr(`memory grep: ${error.message}\n`);
      }
      finish({ exitCode: 2, argsUsed: rgArgs, dirsSearched: dirs }, resolve);
    });

    child.on("close", (code) => {
      flushStdout();
      const rawExit = truncated || emittedLines > 0 ? 0 : code ?? 2;
      const exitCode: 0 | 1 | 2 = rawExit === 0 ? 0 : rawExit === 1 ? 1 : 2;
      finish({ exitCode, argsUsed: rgArgs, dirsSearched: dirs }, resolve);
    });
  });
}
