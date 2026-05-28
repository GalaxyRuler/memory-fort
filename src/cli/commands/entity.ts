import { Command } from "commander";
import {
  collectEntityMergeProposals,
  mergeEntityProposal,
  readEntityAliasMap,
  readEntityMergeProposals,
  rejectEntityMergeProposal,
  writeEntityMergeProposals,
  type EntityMergeProposal,
  type EntityMergeResult,
} from "../../consolidate/entity-dedup.js";
import { memoryRoot as defaultMemoryRoot } from "../../storage/paths.js";
import { commitVaultChange as defaultCommitVaultChange } from "../../sync/commit-vault-change.js";

type CommitVaultChange = typeof defaultCommitVaultChange;

export interface EntityDedupResult {
  mode: "plan" | "apply";
  proposals: EntityMergeProposal[];
  reviewPath?: string;
}

export async function runEntityDedup(opts: {
  vaultRoot: string;
  apply?: boolean;
  commitVaultChange?: CommitVaultChange;
}): Promise<EntityDedupResult> {
  const proposals = await collectEntityMergeProposals(opts.vaultRoot);
  const reviewPath = opts.apply
    ? await writeEntityMergeProposals(opts.vaultRoot, proposals)
    : undefined;
  if (reviewPath) {
    await (opts.commitVaultChange ?? defaultCommitVaultChange)({
      memoryRoot: opts.vaultRoot,
      paths: [reviewPath],
      message: `propose entity merges: ${proposals.length}`,
    });
  }
  return {
    mode: opts.apply ? "apply" : "plan",
    proposals,
    reviewPath,
  };
}

export async function runEntityMerge(opts: {
  vaultRoot: string;
  canonical: string;
  commitVaultChange?: CommitVaultChange;
}): Promise<EntityMergeResult> {
  const result = await mergeEntityProposal(opts.vaultRoot, opts.canonical);
  await (opts.commitVaultChange ?? defaultCommitVaultChange)({
    memoryRoot: opts.vaultRoot,
    paths: [...result.changedFiles, result.aliasMapPath],
    message: `merge entity: ${opts.canonical}`,
  });
  return result;
}

export async function runEntityReject(opts: {
  vaultRoot: string;
  canonical: string;
  commitVaultChange?: CommitVaultChange;
}): Promise<EntityMergeProposal> {
  const rejected = await rejectEntityMergeProposal(opts.vaultRoot, opts.canonical);
  await (opts.commitVaultChange ?? defaultCommitVaultChange)({
    memoryRoot: opts.vaultRoot,
    paths: ["wiki/entity-merges-proposed.json"],
    message: `reject entity: ${rejected.canonical}`,
  });
  return rejected;
}

export function formatEntityDedupResult(result: EntityDedupResult): string {
  const lines = [
    "Memory entity dedup",
    `Mode: ${result.mode}`,
    `Proposed merges: ${result.proposals.length}`,
  ];
  if (result.reviewPath) lines.push(`Review file: ${result.reviewPath}`);
  if (result.proposals.length > 0) {
    lines.push("", "Proposals:");
    for (const proposal of result.proposals) {
      lines.push(
        `  - ${proposal.canonicalTarget} <- [${proposal.aliases.join(", ")}] (${proposal.reason})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatEntityMergeResult(result: EntityMergeResult): string {
  return [
    `Merged aliases into ${result.canonical}`,
    `Aliases recorded: ${result.aliases.length}`,
    `Files rewritten: ${result.changedFiles.length}`,
    `Alias map: ${result.aliasMapPath}`,
    "",
  ].join("\n");
}

export function registerEntityCommand(program: Command): void {
  const entity = program
    .command("entity")
    .description("Review and apply entity deduplication merges");

  entity
    .command("dedup")
    .description("Detect duplicate entity candidates and optionally write a review file")
    .option("--plan", "dry-run; print proposed merges")
    .option("--apply", "write wiki/entity-merges-proposed.json for review")
    .action(async (opts: { plan?: boolean; apply?: boolean }) => {
      if (opts.plan && opts.apply) {
        console.error("memory entity dedup: choose at most one of --plan or --apply");
        process.exit(2);
      }
      try {
        const result = await runEntityDedup({
          vaultRoot: defaultMemoryRoot(),
          apply: Boolean(opts.apply),
        });
        process.stdout.write(formatEntityDedupResult(result));
      } catch (error) {
        console.error(`memory entity dedup failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  entity
    .command("merge <canonical>")
    .description("Apply one reviewed entity merge")
    .action(async (canonical: string) => {
      try {
        const result = await runEntityMerge({ vaultRoot: defaultMemoryRoot(), canonical });
        process.stdout.write(formatEntityMergeResult(result));
      } catch (error) {
        console.error(`memory entity merge failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  entity
    .command("reject <canonical>")
    .description("Remove one proposed entity merge from the review file")
    .action(async (canonical: string) => {
      try {
        const rejected = await runEntityReject({ vaultRoot: defaultMemoryRoot(), canonical });
        console.log(`Rejected entity merge: ${rejected.canonical}`);
      } catch (error) {
        console.error(`memory entity reject failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  entity
    .command("aliases")
    .description("List the current entity alias map")
    .action(async () => {
      try {
        const map = await readEntityAliasMap(defaultMemoryRoot());
        const entries = Object.entries(map.aliases);
        if (entries.length === 0) {
          console.log("No entity aliases recorded.");
          return;
        }
        for (const [alias, canonical] of entries) {
          console.log(`${alias} -> ${canonical}`);
        }
      } catch (error) {
        console.error(`memory entity aliases failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
