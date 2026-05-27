import yaml from "js-yaml";
import type { ThreadCluster } from "../consolidate/thread-cluster.js";
import { chatWithAudit } from "./audit.js";
import type { LLMProvider } from "./types.js";

export interface ThreadProposal {
  title: string;
  summary: string;
  keyDecisions: string[];
  keyLessons: string[];
  openQuestions: string[];
  proposedSlug: string;
}

export interface ThreadProposeOptions {
  llm: LLMProvider;
  vaultRoot: string;
  cluster: ThreadCluster;
}

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
): Promise<ThreadProposal | null> {
  const response = await chatWithAudit({
    llm: opts.llm,
    vaultRoot: opts.vaultRoot,
    consumer: "auto-thread-propose",
    request: {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(opts.cluster) },
      ],
      maxTokens: 1200,
      temperature: 0.2,
    },
  });

  return parseThreadProposal(response.content);
}

export function parseThreadProposal(content: string): ThreadProposal | null {
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

  return {
    title,
    summary,
    keyDecisions: readStringArray(parsed["key_decisions"]).slice(0, 10),
    keyLessons: readStringArray(parsed["key_lessons"]).slice(0, 10),
    openQuestions: readStringArray(parsed["open_questions"]).slice(0, 10),
    proposedSlug,
  };
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
