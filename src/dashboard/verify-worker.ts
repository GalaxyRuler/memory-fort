// Worker entry + spawn helper for running `memory verify` (the /api/health
// report) in a child process. verify loads the embeddings sidecars + corpus and
// peaks into the GBs; doing that in the dashboard (Electron-main) process
// OOM-killed the app. The child prints its VerifyResult as JSON on stdout; the
// parent parses it. The child gets a raised heap so the multi-GB load completes.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runVerify, type VerifyResult, type VerifyRole } from "../cli/commands/verify.js";

function defaultVerifyWorkerPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "verify-worker.mjs");
}

export interface VerifyInChildOptions {
  vaultRoot: string;
  role: VerifyRole;
  includeSearch: boolean;
}

export function runVerifyInChild(
  opts: VerifyInChildOptions,
  spawnOpts: { spawnFn?: typeof spawn; workerPath?: string } = {},
): Promise<VerifyResult> {
  const spawnFn = spawnOpts.spawnFn ?? spawn;
  const workerPath = spawnOpts.workerPath ?? defaultVerifyWorkerPath();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn(
      "node",
      ["--max-old-space-size=8192", workerPath, opts.vaultRoot, opts.role, opts.includeSearch ? "1" : "0"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once("error", rejectPromise);
    // verify exits non-zero when checks fail but still emits a valid report, so
    // parse stdout regardless of the exit code.
    child.once("exit", () => {
      try {
        resolvePromise(JSON.parse(out) as VerifyResult);
      } catch (error) {
        rejectPromise(new Error(`verify worker produced no parseable report: ${(error as Error).message}`));
      }
    });
  });
}

if (process.argv[1]?.endsWith("verify-worker.mjs")) {
  const vaultRoot = process.argv[2];
  const role = process.argv[3] as VerifyRole;
  const includeSearch = process.argv[4] === "1";
  runVerify({ vaultRoot, role, includeSearch })
    .then((result) => {
      process.stdout.write(JSON.stringify(result), () => process.exit(0));
    })
    .catch((error: unknown) => {
      console.error(`[verify-worker] ${(error as Error)?.message ?? String(error)}`);
      process.exit(1);
    });
}
