import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { detectCommunities, type CommunityCluster } from "../../graph/community-detection.js";
import { buildGraph } from "../../retrieval/graph.js";
import { loadSearchCorpus, type SearchDocument } from "../../retrieval/corpus.js";
import { readRelations } from "../../retrieval/relations.js";
import { atomicWrite } from "../../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter } from "../../storage/frontmatter.js";
import { memoryRoot as defaultMemoryRoot } from "../../storage/paths.js";
import { kebabCase } from "../../storage/slug.js";

export type DiscoverThreadsMode = "plan" | "apply";

export interface DiscoverThreadsOptions {
  vaultRoot?: string;
  mode?: DiscoverThreadsMode;
  minClusterSize?: number;
  maxProposals?: number;
  now?: Date;
}

export interface DiscoveredThreadProposal {
  slug: string;
  title: string;
  relPath: string;
  members: string[];
  rawReferences: string[];
}

export interface DiscoverThreadsResult {
  mode: DiscoverThreadsMode;
  proposals: DiscoveredThreadProposal[];
  skipped: Array<{ members: string[]; reason: string }>;
  summary: {
    clusters: number;
    proposals: number;
    written: number;
    skipped: number;
  };
}

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MAX_PROPOSALS = 10;

export async function runDiscoverThreads(opts: DiscoverThreadsOptions = {}): Promise<DiscoverThreadsResult> {
  const vaultRoot = opts.vaultRoot ?? defaultMemoryRoot();
  const mode = opts.mode ?? "plan";
  const now = opts.now ?? new Date();
  const corpus = await loadSearchCorpus({ vaultRoot, scope: "all" });
  const graph = buildGraph(corpus.documents);
  const adjacency = buildWikiAdjacency(graph.edges);
  const clusters = detectCommunities(adjacency, {
    minClusterSize: opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE,
  });
  const existingThreadMembers = await loadThreadMemberSets(vaultRoot);
  const docsByPath = new Map(corpus.documents.map((document) => [document.relPath, document]));
  const proposals: DiscoveredThreadProposal[] = [];
  const skipped: DiscoverThreadsResult["skipped"] = [];

  for (const cluster of clusters) {
    if (proposals.length >= (opts.maxProposals ?? DEFAULT_MAX_PROPOSALS)) break;
    if (isAlreadyMapped(cluster, existingThreadMembers)) {
      skipped.push({ members: cluster.members, reason: "cluster already represented by a thread" });
      continue;
    }
    const proposal = proposalFromCluster(cluster, graph.edges, docsByPath, vaultRoot);
    if (proposal.rawReferences.length === 0) {
      skipped.push({ members: cluster.members, reason: "cluster has no raw references" });
      continue;
    }
    proposals.push(proposal);
  }

  if (mode === "apply") {
    for (const proposal of proposals) {
      const fullPath = join(vaultRoot, ...proposal.relPath.split("/"));
      await mkdir(dirname(fullPath), { recursive: true });
      await atomicWrite(fullPath, formatThreadProposal(proposal, now));
    }
  }

  return {
    mode,
    proposals,
    skipped,
    summary: {
      clusters: clusters.length,
      proposals: proposals.length,
      written: mode === "apply" ? proposals.length : 0,
      skipped: skipped.length,
    },
  };
}

export function formatDiscoverThreadsResult(result: DiscoverThreadsResult): string {
  const lines = [
    "Memory discover-threads",
    `Mode: ${result.mode}`,
    `Clusters found: ${result.summary.clusters}`,
    `Proposals: ${result.summary.proposals}`,
    `Drafts written: ${result.summary.written}`,
    `Skipped: ${result.summary.skipped}`,
  ];
  if (result.proposals.length > 0) {
    lines.push(
      "",
      "Proposals:",
      ...result.proposals.map((proposal) =>
        `  - ${proposal.slug} (${proposal.members.length} entities, ${proposal.rawReferences.length} raw refs) -> ${proposal.relPath}`
      ),
    );
  }
  if (result.skipped.length > 0) {
    lines.push(
      "",
      "Skipped:",
      ...result.skipped.map((skip) => `  - ${skip.reason}: ${skip.members.join(", ")}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildWikiAdjacency(edges: ReturnType<typeof buildGraph>["edges"]): Record<string, Set<string>> {
  const adjacency: Record<string, Set<string>> = {};
  for (const edge of edges) {
    if (!isDiscoveryEntity(edge.fromPath) || !isDiscoveryEntity(edge.toPath)) continue;
    (adjacency[edge.fromPath] ??= new Set()).add(edge.toPath);
    (adjacency[edge.toPath] ??= new Set()).add(edge.fromPath);
  }
  return adjacency;
}

async function loadThreadMemberSets(vaultRoot: string): Promise<Set<string>[]> {
  const threadRoot = join(vaultRoot, "wiki", "threads");
  if (!existsSync(threadRoot)) return [];
  const corpus = await loadSearchCorpus({ vaultRoot, scope: "wiki" });
  return corpus.documents
    .filter((document) => document.relPath.startsWith("wiki/threads/"))
    .map((document) => new Set([
      ...Object.values(document.relations).flatMap((edges) => edges.map((edge) => edge.target)),
    ].filter((target) => target.startsWith("wiki/"))));
}

function isAlreadyMapped(cluster: CommunityCluster, mappedThreads: Set<string>[]): boolean {
  return mappedThreads.some((members) => cluster.members.some((member) => members.has(member)));
}

function proposalFromCluster(
  cluster: CommunityCluster,
  edges: ReturnType<typeof buildGraph>["edges"],
  docsByPath: Map<string, SearchDocument>,
  vaultRoot: string,
): DiscoveredThreadProposal {
  const rawReferences = rawReferencesForCluster(cluster.members, edges, vaultRoot);
  const titles = cluster.members.map((member) => docsByPath.get(member)?.title ?? titleFromPath(member));
  const title = titles.sort((a, b) => a.localeCompare(b)).join(" / ");
  const slug = uniqueProposalSlug(vaultRoot, kebabCase(titles.join(" ")));
  return {
    slug,
    title,
    relPath: `wiki/threads-proposed/${slug}.md`,
    members: cluster.members,
    rawReferences,
  };
}

function rawReferencesForCluster(
  members: string[],
  edges: ReturnType<typeof buildGraph>["edges"],
  vaultRoot: string,
): string[] {
  const memberSet = new Set(members);
  const refs = new Set<string>();
  for (const edge of edges) {
    if (edge.fromPath.startsWith("raw/") && memberSet.has(edge.toPath) && existsSync(join(vaultRoot, ...edge.fromPath.split("/")))) {
      refs.add(edge.fromPath);
    }
    if (edge.toPath.startsWith("raw/") && memberSet.has(edge.fromPath) && existsSync(join(vaultRoot, ...edge.toPath.split("/")))) {
      refs.add(edge.toPath);
    }
  }
  return [...refs].sort((a, b) => a.localeCompare(b));
}

function formatThreadProposal(proposal: DiscoveredThreadProposal, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return serializeFrontmatter(
    {
      type: "threads",
      title: proposal.title,
      created: date,
      updated: date,
      status: "active",
      source: "auto-thread-discovery",
      lifecycle: "proposed",
      cognitive_type: "episodic",
      tags: ["auto-proposed", "thread-discovery"],
      relations: {
        mentions: proposal.rawReferences,
        derived_from: proposal.members,
      },
    },
    [
      `# ${proposal.title}`,
      "",
      "Suggested thread from relation-graph community detection.",
      "",
      "## Entities",
      "",
      ...proposal.members.map((member) => `- ${member}`),
      "",
      "## Raw observations",
      "",
      ...proposal.rawReferences.map((ref) => `- ${ref}`),
      "",
      "---",
      "",
      `**Auto-generated proposal - \`memory discover-threads\` on ${date}.**`,
      "Review and promote manually when coherent.",
      "",
    ].join("\n"),
  );
}

function uniqueProposalSlug(vaultRoot: string, baseSlug: string): string {
  const base = baseSlug || "discovered-thread";
  let slug = base;
  let suffix = 2;
  while (existsSync(join(vaultRoot, "wiki", "threads-proposed", `${slug}.md`))) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function titleFromPath(path: string): string {
  return basename(path, ".md").replace(/-/g, " ");
}

function isDiscoveryEntity(path: string): boolean {
  return [
    "wiki/projects/",
    "wiki/issues/",
    "wiki/people/",
    "wiki/decisions/",
    "wiki/lessons/",
    "wiki/prospective/",
    "wiki/procedures/",
    "wiki/references/",
    "wiki/tools/",
  ].some((prefix) => path.startsWith(prefix));
}
