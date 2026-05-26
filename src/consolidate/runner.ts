import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type Frontmatter,
} from "../storage/frontmatter.js";
import {
  loadSearchCorpus,
  type SearchDocument,
} from "../retrieval/corpus.js";
import {
  combineMentions,
  findBM25Mentions,
  type ConsolidationMention,
} from "./bm25-augment.js";
import { buildTitleIndex, findTitleMentions } from "./title-index.js";

export interface ConsolidatePlan {
  observation: string;
  currentRelations: string[];
  proposedRelations: Array<{
    relPath: string;
    title: string;
    confidence: number;
    source: "lexical" | "bm25" | "both";
  }>;
  willWrite: boolean;
}

export interface ConsolidateOptions {
  plan: boolean;
  minConfidence?: number;
  maxLinksPerObservation?: number;
  corpusRoot: string;
  force?: boolean;
  now?: Date;
}

export interface ConsolidateResult {
  mode: "plan" | "apply";
  plans: ConsolidatePlan[];
  summary: {
    scanned: number;
    proposed: number;
    proposedEdges: number;
    updated: number;
    newEdges: number;
  };
  auditLogPath?: string;
}

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MAX_LINKS = 5;

export async function runConsolidatePlan(
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxLinksPerObservation = opts.maxLinksPerObservation ?? DEFAULT_MAX_LINKS;
  const corpus = await loadSearchCorpus({ vaultRoot: opts.corpusRoot, scope: "all" });
  const titleIndex = buildTitleIndex(corpus.documents);
  const observations = corpus.documents.filter((doc) => doc.kind === "raw");
  const plans = observations.map((observation) => {
    const currentRelations = observation.relations["mentions"] ?? [];
    const skipForIdempotency = currentRelations.length > 0 && !opts.force;
    const proposedRelations = skipForIdempotency
      ? []
      : proposeRelations(observation, corpus.documents, minConfidence, maxLinksPerObservation);
    return {
      observation: observation.relPath,
      currentRelations,
      proposedRelations,
      willWrite: proposedRelations.length > 0,
    };
  });
  const proposed = plans.filter((plan) => plan.willWrite).length;
  const proposedEdges = plans.reduce((sum, plan) => sum + plan.proposedRelations.length, 0);

  let updated = 0;
  let newEdges = 0;
  let auditLogPath: string | undefined;

  if (!opts.plan) {
    for (const plan of plans) {
      if (!plan.willWrite) continue;
      const observation = observations.find((doc) => doc.relPath === plan.observation)!;
      await writeObservationMentions(observation, plan.proposedRelations.map((relation) => relation.relPath));
      updated += 1;
      newEdges += plan.proposedRelations.length;
    }
    auditLogPath = join(
      opts.corpusRoot,
      "wiki",
      ".audit",
      `consolidate-${(opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}.md`,
    );
    await atomicWrite(auditLogPath, formatConsolidateAudit(plans, {
      scanned: observations.length,
      proposed,
      proposedEdges,
      updated,
      newEdges,
    }, opts.now ?? new Date()));
  }

  return {
    mode: opts.plan ? "plan" : "apply",
    plans,
    summary: {
      scanned: observations.length,
      proposed,
      proposedEdges,
      updated,
      newEdges,
    },
    auditLogPath,
  };

  function proposeRelations(
    observation: SearchDocument,
    documents: SearchDocument[],
    threshold: number,
    maxLinks: number,
  ): ConsolidatePlan["proposedRelations"] {
    const lexical = findTitleMentions(observation.body, titleIndex);
    const bm25 = findBM25Mentions(observation.body, documents);
    return combineMentions(lexical, bm25)
      .filter((match) => match.confidence >= threshold)
      .slice(0, maxLinks)
      .map(toProposedRelation);
  }
}

function toProposedRelation(match: ConsolidationMention): ConsolidatePlan["proposedRelations"][number] {
  return {
    relPath: match.relPath,
    title: match.title,
    confidence: match.confidence,
    source: match.source,
  };
}

async function writeObservationMentions(
  observation: SearchDocument,
  mentions: string[],
): Promise<void> {
  const content = await readFile(observation.fullPath, "utf-8");
  const parsed = parseFrontmatter(content);
  const nextFrontmatter: Frontmatter = {
    ...parsed.frontmatter,
    relations: {
      ...(parsed.frontmatter.relations ?? {}),
      mentions,
    },
  };
  await atomicWrite(observation.fullPath, serializeFrontmatter(nextFrontmatter, parsed.body));
}

function formatConsolidateAudit(
  plans: ConsolidatePlan[],
  summary: ConsolidateResult["summary"],
  now: Date,
): string {
  const lines = [
    "# consolidate audit",
    "",
    `started: ${now.toISOString()}`,
    `total scanned: ${summary.scanned}`,
    `total proposed observations: ${summary.proposed}`,
    `total proposed edges: ${summary.proposedEdges}`,
    `total updated: ${summary.updated}`,
    `total new edges: ${summary.newEdges}`,
    "",
  ];

  for (const plan of plans) {
    lines.push(`## ${plan.observation}`, "");
    lines.push(`new relations: ${plan.willWrite ? plan.proposedRelations.length : 0}`);
    for (const relation of plan.proposedRelations) {
      lines.push(`- ${relation.title} -> ${relation.relPath} (${relation.source}, ${relation.confidence.toFixed(2)})`);
    }
    if (plan.proposedRelations.length === 0) {
      lines.push("- no proposed relations");
    }
    lines.push("");
  }

  return `${lines.join("\n")}`;
}
