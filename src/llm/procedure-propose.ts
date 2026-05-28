import yaml from "js-yaml";
import type { ProcedureCluster } from "../consolidate/procedure-detect.js";
import { chatWithAudit } from "./audit.js";
import {
  emptyGroundingStats,
  extractProposalCandidates,
  filterStepCommands,
  formatCandidateList,
  formatMemoryCliList,
  type ProposalCandidates,
  type ProposalGroundingStats,
} from "./proposal-grounding.js";
import type { LLMProvider } from "./types.js";

export interface ProcedureProposal {
  title: string;
  summary: string;
  preconditions: string[];
  steps: Array<{ command?: string; description: string }>;
  verification: string[];
  failureCases: Array<{ condition: string; remedy: string }>;
  tags: string[];
  proposedSlug: string;
  grounding: ProposalGroundingStats;
}

export interface ProcedureProposeOptions {
  llm: LLMProvider;
  vaultRoot: string;
  cluster: ProcedureCluster;
  candidates?: ProposalCandidates;
}

const SYSTEM_PROMPT = `You extract procedural memory pages for Memory Fort. A procedure is a reusable workflow - preconditions, ordered steps, verification, and failure cases - extracted from raw observations where the operator did the same thing successfully across multiple sessions.

Your input is a cluster of raw observations sharing a command-line pattern. Your job: write the procedure page in YAML.

Output exactly this shape, no code fences, no commentary:

title: <imperative form, 10-80 chars>
summary: |
  <1-2 sentences explaining what this procedure accomplishes>
preconditions:
  - <required state before running>
steps:
  - description: <human-readable step>
    command: <shell command if applicable>
verification:
  - <how to confirm the step worked>
failure_cases:
  - condition: <what could go wrong>
    remedy: <how to recover>
tags:
  - <inferred domain tag>
proposed_slug: <kebab-case>

If the cluster doesn't represent a coherent reusable procedure, output: "skip: <reason>" instead. Examples of skip-worthy clusters:
- One-off exploratory work that wouldn't be repeated
- Sessions that happened to share commands by coincidence
- Failed attempts where the actual procedure is unclear`;

export async function proposeProcedure(opts: ProcedureProposeOptions): Promise<ProcedureProposal | null> {
  const candidates = opts.candidates ?? await extractProposalCandidates({
    vaultRoot: opts.vaultRoot,
    observations: opts.cluster.observations,
  });
  let proposal: ProcedureProposal | null = null;
  await chatWithAudit({
    llm: opts.llm,
    vaultRoot: opts.vaultRoot,
    consumer: "auto-procedural-extract",
    request: {
      messages: [
        { role: "system", content: systemPrompt(candidates) },
        { role: "user", content: userPrompt(opts.cluster) },
      ],
      maxTokens: 1600,
      temperature: 0.2,
    },
    auditMetadata: (response) => {
      proposal = groundProcedureProposal(parseProcedureProposal(response.content));
      return {
        referencesStripped: proposal?.grounding.strippedReferenceCount ?? 0,
        strippedSamples: proposal?.grounding.strippedSamples ?? [],
      };
    },
  });

  return proposal;
}

export function parseProcedureProposal(content: string): ProcedureProposal | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (/^skip\s*:/i.test(trimmed)) return null;

  let parsed: unknown;
  try {
    parsed = yaml.load(trimmed, { schema: yaml.JSON_SCHEMA });
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const title = readString(parsed["title"]);
  const summary = readString(parsed["summary"]);
  const proposedSlug = readString(parsed["proposed_slug"]);
  if (!title || !summary || !proposedSlug) return null;
  if (title.length < 10 || title.length > 80) return null;
  if (!/^[a-z0-9-]+$/.test(proposedSlug)) return null;

  const steps = readSteps(parsed["steps"]);
  if (steps.length === 0) return null;

  return {
    title,
    summary,
    preconditions: readStringArray(parsed["preconditions"]).slice(0, 12),
    steps: steps.slice(0, 20),
    verification: readStringArray(parsed["verification"]).slice(0, 12),
    failureCases: readFailureCases(parsed["failure_cases"]).slice(0, 12),
    tags: readStringArray(parsed["tags"]).slice(0, 12),
    proposedSlug,
    grounding: emptyGroundingStats(),
  };
}

function groundProcedureProposal(proposal: ProcedureProposal | null): ProcedureProposal | null {
  if (!proposal) return null;
  const originalReferenceCount = proposal.steps.filter((step) => step.command).length;
  const commands = filterStepCommands(proposal.steps);
  return {
    ...proposal,
    steps: commands.steps,
    grounding: {
      originalReferenceCount,
      strippedReferenceCount: commands.stripped.length,
      stripReasons: commands.stripped.map((command) => `unsupported command: ${command}`),
      strippedSamples: commands.stripped.slice(0, 3),
    },
  };
}

function systemPrompt(candidates: ProposalCandidates): string {
  return `${SYSTEM_PROMPT}

Existing wiki pages you may reference (do not invent paths beyond these):

${formatCandidateList(candidates)}

Real memory CLI commands (use only these in step \`command\` fields):

${formatMemoryCliList()}

If a step's command isn't a real \`memory\` subcommand or an obvious POSIX
shell command (git, npm, ssh, scp, curl, cd, ls, cat), describe it in plain
prose without a \`command\` field. Inventing commands is harmful.`;
}

function userPrompt(cluster: ProcedureCluster): string {
  return `Command signature: ${cluster.signature.join(", ")}
Cluster size: ${cluster.observations.length} observations across ${cluster.distinctSessions} distinct sessions

Observations:
${cluster.observations.map((obs, index) =>
  `[${index + 1}] ${obs.created} (${obs.source}) - ${obs.title}\n${obs.body.slice(0, 1200)}`,
).join("\n\n")}`;
}

function readSteps(value: unknown): ProcedureProposal["steps"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const description = readString(item["description"]);
    if (!description) return [];
    const command = readString(item["command"]);
    return [{ description, ...(command ? { command } : {}) }];
  });
}

function readFailureCases(value: unknown): ProcedureProposal["failureCases"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const condition = readString(item["condition"]);
    const remedy = readString(item["remedy"]);
    return condition && remedy ? [{ condition, remedy }] : [];
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
