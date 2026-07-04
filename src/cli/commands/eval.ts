import type { Command } from "commander";
import {
  downloadLongMemEvalDataset,
  type DownloadLongMemEvalOptions,
} from "../../eval/longmemeval/download.js";
import { runEvalLongMemEval } from "./eval-longmemeval.js";
import { runEvalDispatch } from "./eval-dispatch.js";
import { runEvalPhase5RecallScaffold } from "./eval-phase5-recall.js";

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
    .command("longmemeval")
    .description("Run the LongMemEval-S retrieval benchmark")
    .option("--corpus <path>", "vault root (default: ~/.memory)")
    .option("--dataset <path>", "path to questions.jsonl")
    .option("--k <list>", "comma-separated K values (default: 1,5,10)")
    .option("--limit <n>", "stop after N questions")
    .option("--baseline <r@5>", "fail if Recall@5 falls below this value (default: 0.92)")
    .option("--output <path>", "write JSON report here")
    .option("--markdown <path>", "write markdown report here")
    .option("--verbose", "print per-question hits")
    .action(async (opts) => {
      try {
        const result = await runEvalLongMemEval(opts);
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
      }
    });

  evalCommand
    .command("dispatch")
    .description("Run the dispatch policy eval against the classifyDispatch truth table")
    .option("--gold <path>", "path to dispatch-gold.jsonl (default: ./qa/dispatch-gold.jsonl)")
    .option("--json", "emit raw JSON")
    .action(async (opts: { gold?: string; json?: boolean }) => {
      try {
        const result = await runEvalDispatch(opts);
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
      }
    });

  const phase5Recall = evalCommand
    .command("phase5-recall")
    .description("Run Phase 5 real-vault recall harness utilities");

  phase5Recall
    .command("scaffold")
    .description("Prepare the local index/backfill if requested, then write candidate judged queries")
    .option("--vault <path>", "vault root (default: ~/.memory)")
    .option("--gold <path...>", "gold JSONL files to seed candidates")
    .option("--index-db <path>", "index DB path (default: OS app-data path for the vault)")
    .option("--candidates <path>", "write candidate JSONL here")
    .option("--markdown <path>", "write candidate Markdown here")
    .option("--max-candidates <n>", "maximum candidate rows (default: 75)")
    .option("--prepare-index", "run lexical reconcile and local bge-small vector backfill before scaffolding")
    .option("--batch-size <n>", "vector backfill batch size (default: 16)")
    .action(async (opts) => {
      try {
        const result = await runEvalPhase5RecallScaffold({
          vault: opts.vault,
          gold: opts.gold,
          indexDb: opts.indexDb,
          candidates: opts.candidates,
          markdown: opts.markdown,
          maxCandidates: opts.maxCandidates,
          prepareIndex: opts.prepareIndex,
          batchSize: opts.batchSize,
        });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
      }
    });

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
