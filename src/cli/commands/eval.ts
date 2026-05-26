import type { Command } from "commander";
import {
  downloadLongMemEvalDataset,
  type DownloadLongMemEvalOptions,
} from "../../eval/longmemeval/download.js";

export interface EvalDownloadCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runEvalDownload(
  opts: DownloadLongMemEvalOptions = {},
): Promise<EvalDownloadCliResult> {
  const result = await downloadLongMemEvalDataset(opts);
  const action = result.status === "skipped" ? "already cached" : "downloaded";
  return {
    stdout:
      `LongMemEval-S ${action}: ${result.questionsPath}\n` +
      `Manifest: ${result.manifestPath}\n`,
    stderr: "",
    exitCode: 0,
  };
}

export function registerEvalCommand(program: Command): void {
  const evalCommand = program
    .command("eval")
    .description("Run memory-system evaluation harnesses");

  evalCommand
    .command("download")
    .description("Download evaluation datasets into the local cache")
    .option("--dataset <name>", "dataset to download (default: longmemeval-s)", "longmemeval-s")
    .option("--cache <dir>", "dataset cache root (default: ~/.memory/datasets/)")
    .action(async (opts: { dataset?: "longmemeval-s"; cache?: string }) => {
      try {
        const result = await runEvalDownload({
          dataset: opts.dataset,
          cacheDir: opts.cache,
        });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      } catch (error) {
        console.error((error as Error).message);
        process.exit(typeof (error as { exitCode?: unknown }).exitCode === "number"
          ? (error as { exitCode: number }).exitCode
          : 1);
      }
    });
}
