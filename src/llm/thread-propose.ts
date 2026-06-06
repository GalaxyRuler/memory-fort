import yaml from "js-yaml";
import type { ThreadCluster } from "../consolidate/thread-cluster.js";
import { chatWithAudit, hashPrompt, hashResponse } from "./audit.js";
import {
  emptyGroundingStats,
  extractProposalCandidates,
  filterProsePathLeaksFromStrings,
  filterWikiReferencesToExisting,
  formatCandidateList,
  stripProsePathLeaksFromText,
  type ProposalCandidates,
  type ProposalGroundingStats,
} from "./proposal-grounding.js";
import type { LLMProvider } from "./types.js";

export interface ThreadProposal {
  title: string;
  summary: string;
  keyDecisions: string[];
  keyLessons: string[];
  openQuestions: string[];
  proposedSlug: string;
  grounding: ProposalGroundingStats;
}

export interface ThreadProposeOptions {
  llm: LLMProvider;
  vaultRoot: string;
  cluster: ThreadCluster;
  candidates?: ProposalCandidates;
  env?: NodeJS.ProcessEnv;
}

export type ThreadProposalParseResult =
  | { ok: true; proposal: ThreadProposal }
  | { ok: false; reason: string };

export type ThreadProposeResult =
  | { ok: true; proposal: ThreadProposal; promptHash: string; responseHash: string }
  | { ok: false; reason: string; promptHash: string; responseHash: string };

const SYSTEM_PROMPT = `You draft narrative thread pages for Memory Fort, a personal agent-memory system. A thread aggregates raw observations from a coherent stretch of work - usually 3-30 sessions sharing entities and a time window.

Your job: given a cluster of observations, write the front-matter fields of a thread page in YAML.

Output exactly this shape, no code fences, no commentary:

title: <10-80 chars, no quotes>
summary: |
  <2-3 sentences explaining what arc this represents>
key_decisions:
  - <wiki/decisions/path-or-description>
key_lessons:
  - <wiki/lessons/path-or-description>
open_questions:
  - <unresolved question>
proposed_slug: <kebab-case>

If the cluster doesn't represent a coherent arc, output: "skip: <reason>" instead. The orchestrator will drop that cluster.`;

export async function proposeThread(
  opts: ThreadProposeOptions,
): Promise<ThreadProposeResult> {
  const candidates = opts.candidates ?? await extractProposalCandidates({
    vaultRoot: opts.vaultRoot,
    observations: opts.cluster.observations,
  });
  let parsedProposal: ThreadProposalParseResult | null = null;
  const request = {
    messages: [
      { role: "system" as const, content: systemPrompt(candidates) },
      { role: "user" as const, content: userPrompt(opts.cluster) },
    ],
    maxTokens: 1200,
    temperature: 0.2,
  };
  const promptHash = hashPrompt(request.messages);
  const response = await chatWithAudit({
    llm: opts.llm,
    vaultRoot: opts.vaultRoot,
    consumer: "auto-thread-propose",
    request,
    env: opts.env,
    auditMetadata: async (response) => {
      const parsed = parseThreadProposal(response.content);
      parsedProposal = parsed.ok
        ? { ok: true, proposal: await groundThreadProposal(opts.vaultRoot, parsed.proposal) }
        : parsed;
      return {
        referencesStripped: parsedProposal.ok ? parsedProposal.proposal.grounding.strippedReferenceCount : 0,
        strippedSamples: parsedProposal.ok ? parsedProposal.proposal.grounding.strippedSamples : [],
        prosePathLeaks: parsedProposal.ok ? parsedProposal.proposal.grounding.prosePathLeaksCount : 0,
        prosePathLeakSamples: parsedProposal.ok ? parsedProposal.proposal.grounding.prosePathLeakSamples : [],
      };
    },
  });

  const result = parsedProposal ?? parseThreadProposal(response.content);
  const responseHash = hashResponse(response.content);
  return result.ok
    ? { ok: true, proposal: result.proposal, promptHash, responseHash }
    : { ok: false, reason: result.reason, promptHash, responseHash };
}

export function parseThreadProposal(content: string): ThreadProposalParseResult {
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

  return {
    ok: true,
    proposal: {
      title,
      summary,
      keyDecisions: readStringArray(parsed["key_decisions"]).slice(0, 10),
      keyLessons: readStringArray(parsed["key_lessons"]).slice(0, 10),
      openQuestions: readStringArray(parsed["open_questions"]).slice(0, 10),
      proposedSlug,
      grounding: emptyGroundingStats(),
    },
  };
}

async function groundThreadProposal(
  vaultRoot: string,
  proposal: ThreadProposal,
): Promise<ThreadProposal> {
  const originalReferenceCount = proposal.keyDecisions.length + proposal.keyLessons.length;
  const summary = stripProsePathLeaksFromText(proposal.summary);
  const decisionProse = filterProsePathLeaksFromStrings(proposal.keyDecisions);
  const lessonProse = filterProsePathLeaksFromStrings(proposal.keyLessons);
  const questionProse = filterProsePathLeaksFromStrings(proposal.openQuestions);
  const decisions = await filterWikiReferencesToExisting(vaultRoot, decisionProse.filtered);
  const lessons = await filterWikiReferencesToExisting(vaultRoot, lessonProse.filtered);
  const stripped = [...decisions.stripped, ...lessons.stripped];
  const proseLeaks = [
    ...summary.stripped,
    ...decisionProse.stripped,
    ...lessonProse.stripped,
    ...questionProse.stripped,
  ];
  return {
    ...proposal,
    summary: summary.text,
    keyDecisions: decisions.filtered,
    keyLessons: lessons.filtered,
    openQuestions: questionProse.filtered,
    grounding: {
      originalReferenceCount,
      strippedReferenceCount: stripped.length,
      stripReasons: stripped.map((path) => `missing wiki reference: ${path}`),
      strippedSamples: stripped.slice(0, 3),
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
Never put wiki/<category>/<slug> or raw/<date>/<file> path strings into free-form fields (summary, key_decisions, key_lessons, open_questions). Those fields are human-readable prose. The wiki path list applies to relations only.
Wrong free-form bullet: - wiki/decisions/example-decision-page.md
Correct free-form bullet: - Chose the dashboard validation workflow after comparing the CLI-only option.`;
}

function userPrompt(cluster: ThreadCluster): string {
  return `Cluster: ${cluster.observations.length} observations
Time range: ${cluster.timeRange.start} to ${cluster.timeRange.end}
Shared entities: ${cluster.sharedEntities.join(", ")}

Observations:
${cluster.observations.map((obs, index) =>
  `[${index + 1}] ${obs.created} (${obs.source}) - ${obs.title}\n${obs.snippet}`,
).join("\n\n")}`;
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
