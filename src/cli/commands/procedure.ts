import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Command } from "commander";
import {
  detectProcedureClusters,
  type ProcedureCluster,
  type RawProcedureObservationRef,
} from "../../consolidate/procedure-detect.js";
import { loadSearchCorpus, type SearchDocument } from "../../retrieval/corpus.js";
import {
  createLLMFromConfig,
  getActiveLLMConfig,
  type LLMConfig,
} from "../../llm/factory.js";
import { isDebugLogEnabled } from "../../llm/audit.js";
import { scoreProposalConfidence, type ProposalConfidence } from "../../llm/proposal-confidence.js";
import { proposeProcedure, type ProcedureProposal } from "../../llm/procedure-propose.js";
import { LLMDisabledError, type LLMProvider } from "../../llm/types.js";
import { loadMemoryConfig, type MemoryConfig } from "../../storage/config.js";
import { atomicWrite } from "../../storage/atomic-write.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type Frontmatter,
} from "../../storage/frontmatter.js";
import {
  memoryRoot as defaultMemoryRoot,
  proceduresProposedDir,
} from "../../storage/paths.js";
import { commitVaultChange as defaultCommitVaultChange } from "../../sync/commit-vault-change.js";

type CommitVaultChange = typeof defaultCommitVaultChange;

export interface ProcedureProposeRunOptions {
  vaultRoot: string;
  days?: number;
  maxProposals?: number;
  apply?: boolean;
  autoPromote?: boolean;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  configLoader?: () => Promise<MemoryConfig>;
  llmFactory?: (config: LLMConfig | null, env: NodeJS.ProcessEnv) => LLMProvider;
  commitVaultChange?: CommitVaultChange;
}

export interface ProcedureProposeRunResult {
  scanned: number;
  clustered: number;
  proposed: number;
  written: number;
  autoPromoted: number;
  awaitingReview: number;
  referencesStripped: number;
  skipped: Array<{ clusterIndex: number; reason: string; promptHash?: string; responseHash?: string }>;
  proposals: Array<{
    slug: string;
    title: string;
    relPath: string;
    observationCount: number;
    sessionCount: number;
    confidence: ProposalConfidence;
    autoPromoted: boolean;
  }>;
  auditLogPath: string;
  mode: "plan" | "apply";
}

const DEFAULT_DAYS = 30;
const DEFAULT_MAX_PROPOSALS = 10;

export async function runProcedurePropose(
  opts: ProcedureProposeRunOptions,
): Promise<ProcedureProposeRunResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  if (env["MEMORY_LLM_DISABLED"]?.trim().toLowerCase() === "true") {
    throw new LLMDisabledError();
  }

  const days = opts.days ?? DEFAULT_DAYS;
  const maxProposals = opts.maxProposals ?? DEFAULT_MAX_PROPOSALS;
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(opts.vaultRoot)))();
  const llmConfig = getActiveLLMConfig(config);
  const llm = (opts.llmFactory ?? createLLMFromConfig)(llmConfig, env);
  const corpus = await loadSearchCorpus({ vaultRoot: opts.vaultRoot, scope: "raw" });
  const observations = corpus.documents
    .filter((document) => document.kind === "raw")
    .filter((document) => isWithinLastDays(documentDate(document), days, now))
    .map(toRawProcedureObservationRef);
  const clusters = detectProcedureClusters(observations);
  const selected = clusters.slice(0, Math.max(0, maxProposals));
  const proposals: ProcedureProposeRunResult["proposals"] = [];
  const skipped: ProcedureProposeRunResult["skipped"] = [];
  let written = 0;
  let autoPromoted = 0;
  let awaitingReview = 0;
  let referencesStripped = 0;
  const writtenReviewPaths: string[] = [];

  for (const [clusterIndex, cluster] of selected.entries()) {
    const proposalResult = await proposeProcedure({ llm, vaultRoot: opts.vaultRoot, cluster, env });
    if (!proposalResult.ok) {
      skipped.push(formatSkippedProposal(clusterIndex, proposalResult, env));
      continue;
    }
    const proposal = proposalResult.proposal;
    referencesStripped += proposal.grounding.strippedReferenceCount;

    const slug = uniqueProposalSlug(opts.vaultRoot, proposal.proposedSlug);
    let relPath = `wiki/procedures-proposed/${slug}.md`;
    let proposalAutoPromoted = false;
    const strippedCommands = proposal.grounding.strippedSamples;
    const confidence = scoreProposalConfidence({
      grounding: {
        strippedReferenceCount: proposal.grounding.strippedReferenceCount,
        prosePathLeaksCount: proposal.grounding.prosePathLeaksCount,
        commandsStripped: strippedCommands,
      },
      cluster: {
        observationCount: cluster.observations.length,
        distinctSessions: cluster.distinctSessions,
      },
    });

    if (opts.apply) {
      await atomicWrite(
        join(opts.vaultRoot, ...relPath.split("/")),
        formatProcedureProposalFile({ proposal, cluster, slug, now, vaultRoot: opts.vaultRoot, confidence }),
      );
      written += 1;

      if (opts.autoPromote && confidence.level === "high") {
        const promoted = await runProcedurePromote({ vaultRoot: opts.vaultRoot, slug, commitVaultChange: opts.commitVaultChange });
        relPath = promoted.to;
        proposalAutoPromoted = true;
        autoPromoted += 1;
      } else {
        writtenReviewPaths.push(relPath);
        awaitingReview += 1;
      }
    }

    proposals.push({
      slug,
      title: proposal.title,
      relPath,
      observationCount: cluster.observations.length,
      sessionCount: cluster.distinctSessions,
      confidence,
      autoPromoted: proposalAutoPromoted,
    });
  }

  const auditRelPath = `wiki/.audit/procedure-propose-${now.toISOString().replace(/[:.]/g, "-")}.md`;
  const auditLogPath = join(opts.vaultRoot, ...auditRelPath.split("/"));
  await atomicWrite(auditLogPath, formatProcedureRunAudit({
    now,
    mode: opts.apply ? "apply" : "plan",
    scanned: observations.length,
    clustered: clusters.length,
    selected: selected.length,
    proposals,
    skipped,
    written,
    autoPromoted,
    awaitingReview,
    referencesStripped,
  }));
  if (opts.apply) {
    await (opts.commitVaultChange ?? defaultCommitVaultChange)({
      memoryRoot: opts.vaultRoot,
      paths: [...writtenReviewPaths, auditRelPath],
      message: `propose procedure drafts: ${written}`,
    });
  }

  return {
    scanned: observations.length,
    clustered: clusters.length,
    proposed: proposals.length,
    written,
    autoPromoted,
    awaitingReview,
    referencesStripped,
    skipped,
    proposals,
    auditLogPath,
    mode: opts.apply ? "apply" : "plan",
  };
}

export async function runProcedurePromote(opts: {
  vaultRoot: string;
  slug: string;
  commitVaultChange?: CommitVaultChange;
}): Promise<{ from: string; to: string }> {
  const slug = sanitizeSlug(opts.slug);
  const from = `wiki/procedures-proposed/${slug}.md`;
  const to = `wiki/procedures/${slug}.md`;
  const fromPath = join(opts.vaultRoot, ...from.split("/"));
  const toPath = join(opts.vaultRoot, ...to.split("/"));
  if (!existsSync(fromPath)) {
    throw new Error(`proposed procedure not found: ${from}`);
  }
  if (existsSync(toPath)) {
    throw new Error(`canonical procedure already exists: ${to}`);
  }

  const parsed = parseFrontmatter(await readFile(fromPath, "utf-8"));
  const frontmatter: Frontmatter = {
    ...parsed.frontmatter,
    lifecycle: "consolidated",
    source: "auto-procedural-extract-validated",
  };
  await atomicWrite(toPath, serializeFrontmatter(frontmatter, parsed.body));
  await rm(fromPath);
  await (opts.commitVaultChange ?? defaultCommitVaultChange)({
    memoryRoot: opts.vaultRoot,
    paths: [from, to],
    message: `promote procedure: ${slug}`,
  });
  return { from, to };
}

export async function runProcedureReject(opts: {
  vaultRoot: string;
  slug: string;
  commitVaultChange?: CommitVaultChange;
}): Promise<{ deleted: string }> {
  const slug = sanitizeSlug(opts.slug);
  const deleted = `wiki/procedures-proposed/${slug}.md`;
  const fullPath = join(opts.vaultRoot, ...deleted.split("/"));
  if (!existsSync(fullPath)) {
    throw new Error(`proposed procedure not found: ${deleted}`);
  }
  await rm(fullPath);
  await (opts.commitVaultChange ?? defaultCommitVaultChange)({
    memoryRoot: opts.vaultRoot,
    paths: [deleted],
    message: `reject procedure: ${slug}`,
  });
  return { deleted };
}

export function formatProcedureProposeResult(result: ProcedureProposeRunResult): string {
  const lines = [
    "Memory procedure propose",
    `Mode: ${result.mode}`,
    `Scanned raw observations: ${result.scanned}`,
    `Clusters found: ${result.clustered}`,
    `Proposals accepted: ${result.proposed}`,
    `References stripped: ${result.referencesStripped} (avg ${averageStripped(result.referencesStripped, result.proposed)} per proposal)`,
    `Drafts written: ${result.written}`,
    `Drafts auto-promoted: ${result.autoPromoted}`,
    `Drafts awaiting review: ${result.awaitingReview}`,
    `Audit: ${result.auditLogPath}`,
  ];
  if (result.proposals.length > 0) {
    lines.push(
      "",
      "Proposals:",
      ...result.proposals.map((proposal) =>
        `  - ${proposal.slug} (${proposal.observationCount} observations, ${proposal.sessionCount} sessions) -> ${proposal.relPath}`
      ),
    );
  }
  if (result.skipped.length > 0) {
    lines.push(
      "",
      "Skipped:",
      ...result.skipped.map(formatSkippedLine),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function registerProcedureCommand(program: Command): void {
  const procedure = program
    .command("procedure")
    .description("Propose, promote, or reject procedural memory drafts");

  procedure
    .command("propose")
    .description("Detect repeated command workflows and draft proposed procedure pages with the configured LLM")
    .addHelpText("after", `

Notes:
  Reads the llm: section from ~/.memory/config.yaml and errors if no LLM is configured.
  Honors MEMORY_LLM_DISABLED=true as a kill switch.
  Drafts land in wiki/procedures-proposed/ and are never written directly to wiki/procedures/.
  Detection requires at least 2 distinct sessions per cluster.
  Estimated cost is about $0.001 per proposal on openai/gpt-4o-mini via OpenRouter.`)
    .option("--plan", "dry-run; do not write draft procedure pages")
    .option("--apply", "write draft procedure pages under wiki/procedures-proposed/")
    .option("--auto-promote", "with --apply, promote high-confidence drafts directly to wiki/procedures/")
    .option("--days <n>", "days of raw observations to scan (default: 30)", parseInteger)
    .option("--max-proposals <n>", "maximum LLM proposals to request (default: 10)", parseInteger)
    .action(async (opts: { plan?: boolean; apply?: boolean; autoPromote?: boolean; days?: number; maxProposals?: number }) => {
      if (opts.plan && opts.apply) {
        console.error("memory procedure propose: choose at most one of --plan or --apply");
        process.exit(2);
      }
      try {
        const result = await runProcedurePropose({
          vaultRoot: defaultMemoryRoot(),
          apply: Boolean(opts.apply),
          autoPromote: Boolean(opts.apply && opts.autoPromote),
          days: opts.days,
          maxProposals: opts.maxProposals,
        });
        process.stdout.write(formatProcedureProposeResult(result));
      } catch (err) {
        console.error(`memory procedure propose failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  procedure
    .command("promote <slug>")
    .description("Move a reviewed draft from wiki/procedures-proposed/ to wiki/procedures/")
    .action(async (slug: string) => {
      try {
        const result = await runProcedurePromote({ vaultRoot: defaultMemoryRoot(), slug });
        console.log(`Promoted ${result.from} -> ${result.to}`);
      } catch (err) {
        console.error(`memory procedure promote failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  procedure
    .command("reject <slug>")
    .description("Delete a rejected draft from wiki/procedures-proposed/")
    .action(async (slug: string) => {
      try {
        const result = await runProcedureReject({ vaultRoot: defaultMemoryRoot(), slug });
        console.log(`Rejected ${result.deleted}`);
      } catch (err) {
        console.error(`memory procedure reject failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function toRawProcedureObservationRef(document: SearchDocument): RawProcedureObservationRef {
  return {
    relPath: document.relPath,
    created: documentDate(document),
    relations: document.relations,
    session: document.session,
    source: document.source,
    title: document.title || basename(document.relPath, ".md"),
    body: document.body,
  };
}

function documentDate(document: SearchDocument): string {
  return document.observedAt ?? document.created ?? document.mtime.slice(0, 10);
}

function isWithinLastDays(date: string, days: number, now: Date): boolean {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const min = today - Math.max(0, days) * 24 * 60 * 60 * 1000;
  return parsed >= min && parsed <= today;
}

function formatProcedureProposalFile(opts: {
  proposal: ProcedureProposal;
  cluster: ProcedureCluster;
  slug: string;
  now: Date;
  vaultRoot: string;
  confidence?: ProposalConfidence;
}): string {
  const date = opts.now.toISOString().slice(0, 10);
  const derivedFrom = opts.cluster.observations
    .map((observation) => observation.relPath)
    .filter((relPath) => relationTargetExists(opts.vaultRoot, relPath));
  return serializeFrontmatter(
    {
      type: "procedures",
      title: opts.proposal.title,
      cognitive_type: "procedural",
      source: "auto-procedural-extract",
      lifecycle: "proposed",
      status: "active",
      confidence: {
        extraction: 0.7,
        source: 0.6,
        validation: "unvalidated",
        freshness: date,
        conflict: null,
      },
      created: date,
      updated: date,
      proposal_confidence: opts.confidence
        ? {
            level: opts.confidence.level,
            reasons: opts.confidence.reasons,
            observation_count: opts.cluster.observations.length,
            distinct_sessions: opts.cluster.distinctSessions,
          }
        : undefined,
      tags: uniqueSorted([...opts.proposal.tags, "auto-proposed", "procedure-draft"]),
      relations: {
        derived_from: derivedFrom,
      },
    },
    [
      `# ${opts.proposal.title}`,
      "",
      opts.proposal.summary,
      "",
      "## Preconditions",
      "",
      ...listOrNone(opts.proposal.preconditions).map((item) => `- ${item}`),
      "",
      "## Steps",
      "",
      ...formatSteps(opts.proposal.steps),
      "",
      "## Verification",
      "",
      ...listOrNone(opts.proposal.verification).map((item) => `- ${item}`),
      "",
      "## Failure cases",
      "",
      ...formatFailureCases(opts.proposal.failureCases),
      "",
      "---",
      "",
      `**Auto-generated proposal - \`memory procedure propose\` on ${date}.**`,
      `To promote: \`memory procedure promote ${opts.slug}\`. To reject: \`memory procedure reject ${opts.slug}\`.`,
      "",
    ].join("\n"),
  );
}

function formatSteps(steps: ProcedureProposal["steps"]): string[] {
  if (steps.length === 0) return ["1. none"];
  return steps.flatMap((step, index) => {
    const lines = [`${index + 1}. ${step.description}`];
    if (step.command) {
      lines.push("", "```bash", step.command, "```");
    }
    return lines;
  });
}

function formatFailureCases(failureCases: ProcedureProposal["failureCases"]): string[] {
  if (failureCases.length === 0) return ["- none"];
  return failureCases.map((failureCase) => `- **${failureCase.condition}**: ${failureCase.remedy}`);
}

function formatProcedureRunAudit(input: {
  now: Date;
  mode: "plan" | "apply";
  scanned: number;
  clustered: number;
  selected: number;
  proposals: ProcedureProposeRunResult["proposals"];
  skipped: ProcedureProposeRunResult["skipped"];
  written: number;
  autoPromoted: number;
  awaitingReview: number;
  referencesStripped: number;
}): string {
  const date = input.now.toISOString().slice(0, 10);
  const lines = [
    "# procedure propose audit",
    "",
    `started: ${input.now.toISOString()}`,
    `mode: ${input.mode}`,
    `raw observations scanned: ${input.scanned}`,
    `clusters found: ${input.clustered}`,
    `clusters selected: ${input.selected}`,
    `proposals accepted: ${input.proposals.length}`,
    `references stripped: ${input.referencesStripped} (avg ${averageStripped(input.referencesStripped, input.proposals.length)} per proposal)`,
    `drafts written: ${input.written}`,
    `drafts auto-promoted: ${input.autoPromoted}`,
    `drafts awaiting review: ${input.awaitingReview}`,
    "",
    "## Proposals",
    "",
    ...(input.proposals.length === 0
      ? ["- none"]
      : input.proposals.map((proposal) =>
          `- ${proposal.slug} -> ${proposal.relPath} (${proposal.observationCount} observations, ${proposal.sessionCount} sessions, confidence: ${proposal.confidence.level}, reasons: ${proposal.confidence.reasons.join("; ")}, autoPromoted: ${proposal.autoPromoted})`
        )),
    "",
    "## Skipped",
    "",
    ...(input.skipped.length === 0
      ? ["- none"]
      : input.skipped.map(formatSkippedAuditLine)),
    "",
  ];

  return serializeFrontmatter(
    {
      type: "references",
      title: "procedure propose audit",
      created: date,
      updated: date,
      status: "active",
      source: "auto-procedural-extract",
      cognitive_type: "semantic",
    },
    `${lines.join("\n")}\n`,
  );
}

function uniqueProposalSlug(vaultRoot: string, proposedSlug: string): string {
  const base = sanitizeSlug(proposedSlug);
  let slug = base;
  let suffix = 2;
  while (existsSync(join(proceduresProposedDir(vaultRoot), `${slug}.md`))) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function sanitizeSlug(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`invalid procedure slug: ${slug}`);
  }
  return slug;
}

function listOrNone(items: string[]): string[] {
  return items.length > 0 ? items : ["none"];
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))]
    .sort((a, b) => a.localeCompare(b));
}

function averageStripped(stripped: number, proposals: number): string {
  return proposals > 0 ? (stripped / proposals).toFixed(1) : "0.0";
}

function formatSkippedProposal(
  clusterIndex: number,
  result: { reason: string; promptHash: string; responseHash: string },
  env: NodeJS.ProcessEnv,
): ProcedureProposeRunResult["skipped"][number] {
  return {
    clusterIndex,
    reason: result.reason,
    ...(isDebugLogEnabled(env)
      ? { promptHash: result.promptHash, responseHash: result.responseHash }
      : {}),
  };
}

function formatSkippedLine(skip: ProcedureProposeRunResult["skipped"][number]): string {
  const hashes = skip.promptHash && skip.responseHash
    ? ` (hashes prompt=${skip.promptHash}, response=${skip.responseHash})`
    : "";
  return `  - cluster ${skip.clusterIndex}: ${skip.reason}${hashes}`;
}

function formatSkippedAuditLine(skip: ProcedureProposeRunResult["skipped"][number]): string {
  return formatSkippedLine(skip).trim();
}

function relationTargetExists(vaultRoot: string, relPath: string): boolean {
  if (relPath.includes("..")) return false;
  if (!relPath.startsWith("wiki/") && !relPath.startsWith("raw/")) return false;
  return existsSync(join(vaultRoot, ...relPath.split("/")));
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }
  return parsed;
}
