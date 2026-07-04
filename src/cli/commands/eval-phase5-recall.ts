import { join, resolve } from "node:path";
import { memoryRoot } from "../../storage/paths.js";
import { resolveIndexDbPath } from "../../index/db.js";
import type { ReconcileIndexResult } from "../../index/reconcile.js";
import type { BackfillVectorsResult } from "../../index/backfill.js";
import {
  scaffoldPhase5RecallCandidates,
  writePhase5RecallCandidateFiles,
  type Phase5LocalVectorProfile,
  type Phase5RecallCandidate,
  type ScaffoldPhase5RecallCandidatesOptions,
} from "../../eval/retrieval/phase5-recall.js";

export interface EvalPhase5RecallScaffoldFlags {
  readonly vault?: string;
  readonly gold?: readonly string[];
  readonly indexDb?: string;
  readonly candidates?: string;
  readonly markdown?: string;
  readonly maxCandidates?: number | string;
  readonly prepareIndex?: boolean;
  readonly batchSize?: number | string;
  readonly cwd?: string;
  readonly prepareIndexFn?: (opts: PreparePhase5RecallIndexOptions) => Promise<PreparePhase5RecallIndexResult>;
  readonly scaffoldFn?: (opts: ScaffoldPhase5RecallCandidatesOptions) => Promise<Phase5RecallCandidate[]>;
}

export interface EvalPhase5RecallCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface PreparePhase5RecallIndexOptions {
  readonly vaultRoot: string;
  readonly indexDbPath?: string;
  readonly batchSize?: number;
}

export interface PreparePhase5RecallIndexResult extends ReconcileIndexResult {
  readonly indexDbPath: string;
  readonly backfill: BackfillVectorsResult;
  readonly profile: Phase5LocalVectorProfile;
}

const DEFAULT_GOLD_FILES = ["qa/retrieval-gold.jsonl", "qa/graph-aware-gold.jsonl"];
const DEFAULT_MAX_CANDIDATES = 75;
const DEFAULT_BACKFILL_BATCH_SIZE = 16;

export async function runEvalPhase5RecallScaffold(
  flags: EvalPhase5RecallScaffoldFlags = {},
): Promise<EvalPhase5RecallCliResult> {
  const cwd = flags.cwd ?? process.cwd();
  const vaultRoot = resolve(flags.vault ?? memoryRoot());
  const indexDbPath = flags.indexDb ? resolve(flags.indexDb) : resolveIndexDbPath({ vaultRoot });
  const maxCandidates = parseOptionalPositiveInt(flags.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
  const outputPaths = resolveOutputPaths(flags, cwd);
  const goldPaths = (flags.gold && flags.gold.length > 0 ? flags.gold : DEFAULT_GOLD_FILES)
    .map((path) => resolve(cwd, path));

  let prepareResult: PreparePhase5RecallIndexResult | null = null;
  if (flags.prepareIndex) {
    prepareResult = await (flags.prepareIndexFn ?? preparePhase5RecallIndex)({
      vaultRoot,
      indexDbPath,
      batchSize: parseOptionalPositiveInt(flags.batchSize, DEFAULT_BACKFILL_BATCH_SIZE, "batchSize"),
    });
  }

  const candidates = await (flags.scaffoldFn ?? scaffoldPhase5RecallCandidates)({
    vaultRoot,
    goldPaths,
    maxCandidates,
  });
  await writePhase5RecallCandidateFiles({
    candidates,
    jsonlPath: outputPaths.jsonlPath,
    markdownPath: outputPaths.markdownPath,
    vaultRoot,
  });

  return {
    stdout: formatScaffoldResult({
      candidates,
      jsonlPath: outputPaths.jsonlPath,
      markdownPath: outputPaths.markdownPath,
      prepareResult,
    }),
    stderr: "",
    exitCode: 0,
  };
}

export async function preparePhase5RecallIndex(
  opts: PreparePhase5RecallIndexOptions,
): Promise<PreparePhase5RecallIndexResult> {
  const [{ openIndexDb }, { reconcileIndex }, { backfillVectors }, { createLocalBgeSmallEmbedClient }] =
    await Promise.all([
      import("../../index/db.js"),
      import("../../index/reconcile.js"),
      import("../../index/backfill.js"),
      import("../../index/embed.js"),
    ]);
  const indexDbPath = opts.indexDbPath ?? resolveIndexDbPath({ vaultRoot: opts.vaultRoot });
  const indexDb = openIndexDb(indexDbPath);
  try {
    const reconcile = await reconcileIndex(indexDb, opts.vaultRoot);
    const embedder = await createLocalBgeSmallEmbedClient();
    const backfill = await backfillVectors(indexDb.database, {
      embedder,
      profile: embedder.profile,
      batchSize: opts.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE,
    });
    return {
      ...reconcile,
      indexDbPath: indexDb.path,
      backfill,
      profile: {
        provider: embedder.profile.provider,
        modelId: embedder.profile.modelId,
        dimension: embedder.profile.dimension,
        dtype: embedder.profile.dtype,
      },
    };
  } finally {
    indexDb.close();
  }
}

function resolveOutputPaths(
  flags: EvalPhase5RecallScaffoldFlags,
  cwd: string,
): { readonly jsonlPath: string; readonly markdownPath: string } {
  const date = new Date().toISOString().slice(0, 10);
  const defaultRoot = join(cwd, "var", "phase5-task5");
  return {
    jsonlPath: resolve(flags.candidates ?? join(defaultRoot, `phase5-task5-candidate-queries-${date}.jsonl`)),
    markdownPath: resolve(flags.markdown ?? join(defaultRoot, `phase5-task5-candidate-queries-${date}.md`)),
  };
}

function formatScaffoldResult(opts: {
  readonly candidates: readonly Phase5RecallCandidate[];
  readonly jsonlPath: string;
  readonly markdownPath: string;
  readonly prepareResult: PreparePhase5RecallIndexResult | null;
}): string {
  const lines = [
    `Phase 5 recall candidates: ${opts.candidates.length}`,
    `JSONL: ${opts.jsonlPath}`,
    `Markdown: ${opts.markdownPath}`,
  ];
  if (opts.prepareResult) {
    lines.push(
      `Index DB: ${opts.prepareResult.indexDbPath}`,
      `Indexed: files=${opts.prepareResult.filesIndexed} tombstoned=${opts.prepareResult.filesTombstoned} chunks=${opts.prepareResult.chunks} skipped=${opts.prepareResult.filesSkipped}`,
      `Vector backfill: processed=${opts.prepareResult.backfill.processed} embedded=${opts.prepareResult.backfill.embedded} reused=${opts.prepareResult.backfill.reused} failed=${opts.prepareResult.backfill.failed} stale=${opts.prepareResult.backfill.stale} cancelled=${opts.prepareResult.backfill.cancelled}`,
      `Profile: ${opts.prepareResult.profile.provider}/${opts.prepareResult.profile.modelId} dim=${opts.prepareResult.profile.dimension} dtype=${opts.prepareResult.profile.dtype}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseOptionalPositiveInt(
  value: number | string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --${label}: ${value}`);
  }
  return parsed;
}
