import yaml from "js-yaml";
import type { ProcedureCluster } from "../consolidate/procedure-detect.js";
import { chatWithAudit, hashPrompt, hashResponse } from "./audit.js";
import {
  emptyGroundingStats,
  extractProposalCandidates,
  filterProsePathLeaksFromStrings,
  filterStepCommands,
  formatCandidateList,
  formatMemoryCliList,
  stripProsePathLeaksFromText,
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
  env?: NodeJS.ProcessEnv;
}

export type ProcedureProposalParseResult =
  | { ok: true; proposal: ProcedureProposal }
  | { ok: false; reason: string };

export type ProcedureProposeResult =
  | { ok: true; proposal: ProcedureProposal; promptHash: string; responseHash: string }
  | { ok: false; reason: string; promptHash: string; responseHash: string };

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

export async function proposeProcedure(opts: ProcedureProposeOptions): Promise<ProcedureProposeResult> {
  const candidates = opts.candidates ?? await extractProposalCandidates({
    vaultRoot: opts.vaultRoot,
    observations: opts.cluster.observations,
  });
  let parsedProposal: ProcedureProposalParseResult | null = null;
  const request = {
    messages: [
      { role: "system" as const, content: systemPrompt(candidates) },
      { role: "user" as const, content: userPrompt(opts.cluster) },
    ],
    maxTokens: 1600,
    temperature: 0.2,
  };
  const promptHash = hashPrompt(request.messages);
  const response = await chatWithAudit({
    llm: opts.llm,
    vaultRoot: opts.vaultRoot,
    consumer: "auto-procedural-extract",
    request,
    env: opts.env,
    auditMetadata: (response) => {
      const parsed = parseProcedureProposal(response.content);
      parsedProposal = parsed.ok
        ? { ok: true, proposal: groundProcedureProposal(parsed.proposal) }
        : parsed;
      return {
        referencesStripped: parsedProposal.ok ? parsedProposal.proposal.grounding.strippedReferenceCount : 0,
        strippedSamples: parsedProposal.ok ? parsedProposal.proposal.grounding.strippedSamples : [],
        prosePathLeaks: parsedProposal.ok ? parsedProposal.proposal.grounding.prosePathLeaksCount : 0,
        prosePathLeakSamples: parsedProposal.ok ? parsedProposal.proposal.grounding.prosePathLeakSamples : [],
      };
    },
  });

  const result = parsedProposal ?? parseProcedureProposal(response.content);
  const responseHash = hashResponse(response.content);
  return result.ok
    ? { ok: true, proposal: result.proposal, promptHash, responseHash }
    : { ok: false, reason: result.reason, promptHash, responseHash };
}

export function parseProcedureProposal(content: string): ProcedureProposalParseResult {
  const trimmed = content.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty content" };
  const skipMatch = /^skip\s*:\s*(.*)$/i.exec(trimmed);
  if (skipMatch) {
    return { ok: false, reason: `model skipped: ${skipMatch[1]?.trim() || "no reason"}` };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(trimmed, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    return { ok: false, reason: `yaml parse error: ${(error as Error).message}` };
  }

  if (!isRecord(parsed)) return { ok: false, reason: "yaml root is not an object" };
  const title = readString(parsed["title"]);
  const summary = readString(parsed["summary"]);
  const proposedSlug = readString(parsed["proposed_slug"]);
  if (!title) return { ok: false, reason: "missing required field: title" };
  if (!summary) return { ok: false, reason: "missing required field: summary" };
  if (!proposedSlug) return { ok: false, reason: "missing required field: proposed_slug" };
  if (title.length < 10 || title.length > 80) {
    return { ok: false, reason: `title length out of bounds (got ${title.length}, expected 10-80)` };
  }
  if (!/^[a-z0-9-]+$/.test(proposedSlug)) {
    return { ok: false, reason: `invalid proposed_slug: ${proposedSlug}` };
  }

  const steps = readSteps(parsed["steps"]);
  if (steps.length === 0) return { ok: false, reason: "steps array empty" };

  return {
    ok: true,
    proposal: {
      title,
      summary,
      preconditions: readStringArray(parsed["preconditions"]).slice(0, 12),
      steps: steps.slice(0, 20),
      verification: readStringArray(parsed["verification"]).slice(0, 12),
      failureCases: readFailureCases(parsed["failure_cases"]).slice(0, 12),
      tags: readStringArray(parsed["tags"]).slice(0, 12),
      proposedSlug,
      grounding: emptyGroundingStats(),
    },
  };
}

function groundProcedureProposal(proposal: ProcedureProposal): ProcedureProposal {
  const originalReferenceCount = proposal.steps.filter((step) => step.command).length;
  const summary = stripProsePathLeaksFromText(proposal.summary);
  const preconditions = filterProsePathLeaksFromStrings(proposal.preconditions);
  const verification = filterProsePathLeaksFromStrings(proposal.verification);
  const steps = filterProcedureStepProse(proposal.steps);
  const failureCases = filterFailureCaseProse(proposal.failureCases);
  const commands = filterStepCommands(steps.filtered);
  const proseLeaks = [
    ...summary.stripped,
    ...preconditions.stripped,
    ...steps.stripped,
    ...verification.stripped,
    ...failureCases.stripped,
  ];
  return {
    ...proposal,
    summary: summary.text,
    preconditions: preconditions.filtered,
    steps: commands.steps,
    verification: verification.filtered,
    failureCases: failureCases.filtered,
    grounding: {
      originalReferenceCount,
      strippedReferenceCount: commands.stripped.length,
      stripReasons: commands.stripped.map((command) => `unsupported command: ${command}`),
      strippedSamples: commands.stripped.slice(0, 3),
      prosePathLeaksCount: proseLeaks.length,
      prosePathLeakSamples: proseLeaks.slice(0, 3),
    },
  };
}

function systemPrompt(candidates: ProposalCandidates): string {
  return `${SYSTEM_PROMPT}

Existing wiki pages you may reference (do not invent paths beyond these):

${formatCandidateList(candidates)}

These paths are relation candidates for the orchestrator. They belong only in
relations.mentions[] or relations.derived_from[] if the orchestrator writes
relations later; they do not belong in your YAML output fields.

Free-form field guardrails:
Never put wiki/<category>/<slug> or raw/<date>/<file> path strings into free-form fields (summary, preconditions, steps[].description, verification, failure_cases). Those fields are human-readable prose. The wiki path list applies to relations only.
Wrong free-form bullet: - wiki/procedures/example-procedure-page.md
Correct free-form bullet: - Confirm the dashboard health endpoint after copying the bundle.

Real memory CLI commands (use only these in step \`command\` fields):

${formatMemoryCliList()}

If a step's command isn't a real \`memory\` subcommand or an obvious POSIX
shell command (git, npm, ssh, scp, curl, cd, ls, cat), describe it in plain
prose without a \`command\` field. Inventing commands is harmful.`;
}

function filterProcedureStepProse(
  steps: ProcedureProposal["steps"],
): { filtered: ProcedureProposal["steps"]; stripped: string[] } {
  const filtered: ProcedureProposal["steps"] = [];
  const stripped: string[] = [];
  for (const step of steps) {
    const description = stripProsePathLeaksFromText(step.description);
    stripped.push(...description.stripped);
    if (description.text.length === 0) continue;
    filtered.push({ ...step, description: description.text });
  }
  return { filtered, stripped };
}

function filterFailureCaseProse(
  failureCases: ProcedureProposal["failureCases"],
): { filtered: ProcedureProposal["failureCases"]; stripped: string[] } {
  const filtered: ProcedureProposal["failureCases"] = [];
  const stripped: string[] = [];
  for (const failureCase of failureCases) {
    const condition = stripProsePathLeaksFromText(failureCase.condition);
    const remedy = stripProsePathLeaksFromText(failureCase.remedy);
    stripped.push(...condition.stripped, ...remedy.stripped);
    if (condition.text.length === 0 || remedy.text.length === 0) continue;
    filtered.push({ condition: condition.text, remedy: remedy.text });
  }
  return { filtered, stripped };
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
