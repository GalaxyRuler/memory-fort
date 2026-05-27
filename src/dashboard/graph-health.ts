import type { GraphFeed } from "./loaders.js";

export type HealthStatus = "pass" | "warn" | "fail" | "n/a";

export interface MetricResult {
  id: string;
  label: string;
  value: number | string | null;
  unit?: string;
  threshold: { warn?: number; fail?: number; rule?: string };
  status: HealthStatus;
  detail: string;
  topOffenders: Array<{
    path?: string;
    edge?: { from: string; to: string; type: string };
    pair?: [string, string];
    value?: number | string;
    note?: string;
    exempt?: boolean;
    reason?: string;
  }>;
}

export interface GraphHealthReport {
  computedAt: string;
  metrics: MetricResult[];
  overallStatus: HealthStatus;
}

export interface GraphHealthInput {
  feed: GraphFeed;
  wikiPages: ReadonlyArray<WikiHealthPage>;
}

export interface WikiHealthPage {
  relPath: string;
  title: string;
  source?: string | null;
  confidence?: number | object | null;
  confidenceFull?: unknown;
  created?: string | null;
  updated?: string | null;
  importedFrom?: { system: string | null; originalKey: string | null } | null;
}

type GraphNode = GraphFeed["nodes"][number];
type GraphEdge = GraphFeed["edges"][number];
type Offender = MetricResult["topOffenders"][number];

const STOP_WORDS = new Set(["the", "a", "memory", "fort", "system"]);
const STATUS_RANK: Record<HealthStatus, number> = {
  "n/a": 0,
  pass: 1,
  warn: 2,
  fail: 3,
};
const EXEMPT_HUB_PATTERNS = [
  /^wiki\/projects\/[^/]+\.md$/,
];
// HUB_OVERLOAD_WARN/FAIL calibrated against live vault distribution as of
// Phase 3.3 (2026-05-27): 1398 edges / ~22 active wiki pages -> avg inbound 65.
// Warn at 3x avg, fail at 10x avg. Revisit if graph shape changes substantially.
const HUB_OVERLOAD_WARN = 200;
const HUB_OVERLOAD_FAIL = 650;
const PROJECT_HUB_EXEMPTION_REASON = "project hub - by-design anchor";

export function computeGraphHealth(input: GraphHealthInput): GraphHealthReport {
  const { feed } = input;
  const metrics = [
    metricOrphanEpisodic(feed),
    metricDuplicateEntities(input),
    metricEdgeTypeEntropy(feed),
    metricCrossGalaxyRatio(feed),
    metricHubOverload(feed),
    metricTemporalCoverage(feed),
    metricProvenanceCoverage(input),
    metricConfidenceCoverage(input),
    metricContradictionCoverage(feed),
    metricProjectSubgraphDensity(feed),
    metricAgentAttribution(input),
    metricGraphParticipationRate(input),
    metricNarrativeThreadCoverage(feed),
  ];

  return {
    computedAt: new Date().toISOString(),
    metrics,
    overallStatus: worstStatus(metrics.map((metric) => metric.status)),
  };
}

export function metricOrphanEpisodic(feed: GraphFeed): MetricResult {
  const episodic = feed.nodes.filter((node) => node.kind === "raw");
  const orphaned = episodic.filter((node) => degree(node) === 0);
  const value = percentage(orphaned.length, episodic.length);

  return {
    id: "graph.orphan-episodic",
    label: "Orphan episodic rate",
    value,
    unit: "%",
    threshold: { warn: 10, fail: 25, rule: "warn > 10%, fail > 25%" },
    status: statusAbove(value, 10, 25),
    detail: `${orphaned.length}/${episodic.length} raw observations have no relation edges`,
    topOffenders: oldestNodes(orphaned, 5).map((node) => ({
      path: node.path,
      value: node.created ?? node.updated ?? "unknown",
      note: "orphan raw observation",
    })),
  };
}

export function metricDuplicateEntities(input: GraphHealthInput): MetricResult {
  const normalized = input.wikiPages.map((page) => ({
    page,
    title: normalizeTitle(page.title),
  })).filter((entry) => entry.title.length > 0);

  const pairs = new Map<string, { pair: [WikiHealthPage, WikiHealthPage]; similarity: number }>();
  const buckets = new Map<string, WikiHealthPage[]>();
  for (const entry of normalized) {
    buckets.set(entry.title, [...(buckets.get(entry.title) ?? []), entry.page]);
  }

  for (const nodes of buckets.values()) {
    forEachPair(nodes, (left, right) => {
      addDuplicatePagePair(pairs, left, right, 1);
    });
  }

  forEachPair(normalized, (left, right) => {
    if (left.title === right.title) return;
    const distance = levenshtein(left.title, right.title);
    if (distance > 2) return;
    const maxLength = Math.max(left.title.length, right.title.length, 1);
    addDuplicatePagePair(pairs, left.page, right.page, 1 - distance / maxLength);
  });

  const sortedPairs = [...pairs.values()]
    .sort((a, b) =>
      b.similarity - a.similarity ||
      a.pair[0].relPath.localeCompare(b.pair[0].relPath) ||
      a.pair[1].relPath.localeCompare(b.pair[1].relPath),
    );

  return {
    id: "graph.duplicate-entities",
    label: "Duplicate entities",
    value: sortedPairs.length,
    unit: "count",
    threshold: { warn: 3, fail: 10, rule: "warn >= 3 pairs, fail >= 10 pairs" },
    status: statusAtLeast(sortedPairs.length, 3, 10),
    detail: `${sortedPairs.length} duplicate wiki entity candidate pairs found`,
    topOffenders: sortedPairs.slice(0, 5).map(({ pair, similarity }) => ({
      pair: [pair[0].relPath, pair[1].relPath],
      value: round(similarity, 3),
      note: `${pair[0].title} ~ ${pair[1].title}`,
    })),
  };
}

export function metricEdgeTypeEntropy(feed: GraphFeed): MetricResult {
  if (feed.edges.length === 0) {
    return metric({
      id: "graph.edge-type-entropy",
      label: "Edge type entropy",
      value: 0,
      unit: "bits",
      threshold: { warn: 0.8, fail: 0.4, rule: "warn < 0.8 bits, fail < 0.4 bits" },
      status: "pass",
      detail: "no edges available for entropy measurement",
    });
  }

  const counts = countBy(feed.edges, (edge) => edge.type);
  const capped = capDistribution(counts, 9);
  const entropy = [...capped.values()].reduce((sum, count) => {
    const p = count / feed.edges.length;
    return sum - p * Math.log2(p);
  }, 0);
  const dominant = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3);

  return {
    id: "graph.edge-type-entropy",
    label: "Edge type entropy",
    value: round(entropy, 2),
    unit: "bits",
    threshold: { warn: 0.8, fail: 0.4, rule: "warn < 0.8 bits, fail < 0.4 bits" },
    status: statusBelow(entropy, 0.8, 0.4),
    detail: `Shannon entropy across ${feed.edges.length} edges and ${counts.size} edge types`,
    topOffenders: dominant.map(([type, count]) => ({
      value: `${round((count / feed.edges.length) * 100, 1).toFixed(1)}%`,
      note: type,
    })),
  };
}

export function metricCrossGalaxyRatio(feed: GraphFeed): MetricResult {
  const nodes = nodeMap(feed);
  const cross = feed.edges.filter((edge) => {
    const from = nodes.get(edge.fromPath);
    const to = nodes.get(edge.toPath);
    return Boolean(from && to && from.cognitiveType !== to.cognitiveType);
  });
  const value = percentage(cross.length, feed.edges.length);
  const directions = countBy(cross, (edge) => {
    const from = nodes.get(edge.fromPath)?.cognitiveType ?? "unknown";
    const to = nodes.get(edge.toPath)?.cognitiveType ?? "unknown";
    return `${from}→${to}`;
  });
  const topCrossings = [...directions.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([direction, count]) => `${direction} ${count}`)
    .join(", ");

  return {
    id: "graph.cross-galaxy-ratio",
    label: "Cross-galaxy ratio",
    value,
    unit: "%",
    threshold: { warn: 95, fail: 99, rule: "warn > 95%, fail > 99%" },
    status: statusAbove(value, 95, 99),
    detail: `${value}% (${cross.length}/${feed.edges.length}) edges connect different cognitive galaxies${topCrossings ? `; top crossings: ${topCrossings}` : ""}`,
    topOffenders: recentEdges(cross, nodes, 5).map(edgeOffender),
  };
}

export function metricHubOverload(feed: GraphFeed): MetricResult {
  const allNodes = feed.nodes.map((node) => ({
    node,
    degree: degree(node),
    exempt: isExemptHub(node.path),
  }));
  const nonExempt = allNodes.filter((entry) => !entry.exempt);
  const maxDegree = nonExempt.length === 0
    ? 0
    : Math.max(...nonExempt.map((entry) => entry.degree));

  return {
    id: "graph.hub-overload",
    label: "Hub overload (non-project nodes)",
    value: maxDegree,
    unit: "count",
    threshold: { warn: HUB_OVERLOAD_WARN, fail: HUB_OVERLOAD_FAIL, rule: "warn > 200 edges, fail > 650 edges" },
    status: statusAbove(maxDegree, HUB_OVERLOAD_WARN, HUB_OVERLOAD_FAIL),
    detail: `highest non-exempt single-node degree is ${maxDegree}`,
    topOffenders: allNodes
      .sort((a, b) => b.degree - a.degree || a.node.path.localeCompare(b.node.path))
      .slice(0, 5)
      .filter((entry) => entry.degree > 0)
      .map((entry) => ({
        path: entry.node.path,
        value: entry.degree,
        note: entry.exempt
          ? `exempt (${PROJECT_HUB_EXEMPTION_REASON}); ${entry.node.inboundCount} inbound, ${entry.node.outboundCount} outbound`
          : `${entry.node.inboundCount} inbound, ${entry.node.outboundCount} outbound`,
        exempt: entry.exempt || undefined,
        reason: entry.exempt ? PROJECT_HUB_EXEMPTION_REASON : undefined,
      })),
  };
}

export function metricTemporalCoverage(feed: GraphFeed): MetricResult {
  if (feed.edges.length === 0) {
    return metric({
      id: "graph.temporal-coverage",
      label: "Temporal coverage",
      value: 0,
      unit: "%",
      threshold: { warn: 60, fail: 30, rule: "warn < 60%, fail < 30%" },
      status: "pass",
      detail: "no edges available for temporal coverage measurement",
    });
  }

  const covered = feed.edges.filter((edge) => hasText(edge.validFrom));
  const missing = feed.edges.filter((edge) => !hasText(edge.validFrom));
  const value = percentage(covered.length, feed.edges.length);
  const nodes = nodeMap(feed);

  return {
    id: "graph.temporal-coverage",
    label: "Temporal coverage",
    value,
    unit: "%",
    threshold: { warn: 60, fail: 30, rule: "warn < 60%, fail < 30%" },
    status: statusBelow(value, 60, 30),
    detail: `${covered.length}/${feed.edges.length} edges include validFrom`,
    topOffenders: recentEdges(missing, nodes, 5).map(edgeOffender),
  };
}

export function metricProvenanceCoverage(input: GraphHealthInput): MetricResult {
  const pages = input.wikiPages;
  if (pages.length === 0) {
    return metric({
      id: "graph.provenance-coverage",
      label: "Provenance coverage",
      value: 0,
      unit: "%",
      threshold: { warn: 80, fail: 50, rule: "warn < 80%, fail < 50%" },
      status: "pass",
      detail: "no wiki pages available for provenance coverage measurement",
    });
  }

  const covered = pages.filter((page) => hasKnownSource(page.source) || hasImportedFrom(page.importedFrom));
  const missing = pages.filter((page) => !hasKnownSource(page.source) && !hasImportedFrom(page.importedFrom));
  const value = percentage(covered.length, pages.length);

  return {
    id: "graph.provenance-coverage",
    label: "Provenance coverage",
    value,
    unit: "%",
    threshold: { warn: 80, fail: 50, rule: "warn < 80%, fail < 50%" },
    status: statusBelow(value, 80, 50),
    detail: `${covered.length}/${pages.length} wiki pages expose source or imported_from provenance`,
    topOffenders: recentWikiPages(missing, 5).map((page) => ({
      path: page.relPath,
      value: page.updated ?? page.created ?? "unknown",
      note: "missing source",
    })),
  };
}

export function metricConfidenceCoverage(input: GraphHealthInput): MetricResult {
  const pages = input.wikiPages;
  if (pages.length === 0) {
    return metric({
      id: "graph.confidence-coverage",
      label: "Confidence coverage",
      value: 0,
      unit: "%",
      threshold: { warn: 70, fail: 40, rule: "warn < 70%, fail < 40%" },
      status: "pass",
      detail: "no wiki pages available for confidence coverage measurement",
    });
  }

  const covered = pages.filter(hasConfidenceMetadata);
  const missing = pages.filter((page) => !hasConfidenceMetadata(page));
  const value = percentage(covered.length, pages.length);

  return {
    id: "graph.confidence-coverage",
    label: "Confidence coverage",
    value,
    unit: "%",
    threshold: { warn: 70, fail: 40, rule: "warn < 70%, fail < 40%" },
    status: statusBelow(value, 70, 40),
    detail: `${covered.length}/${pages.length} wiki pages include confidence metadata`,
    topOffenders: missing.slice(0, 5).map((page) => ({
      path: page.relPath,
      note: "missing confidence",
    })),
  };
}

export function metricContradictionCoverage(feed: GraphFeed): MetricResult {
  const contradictions = feed.edges.filter((edge) => edge.type === "contradicts" || edge.relationType === "contradicts");
  const nodes = nodeMap(feed);

  return {
    id: "graph.contradiction-coverage",
    label: "Contradiction coverage",
    value: contradictions.length,
    unit: "count",
    threshold: { warn: 5, fail: 20, rule: "warn > 5 edges, fail > 20 edges" },
    status: statusAbove(contradictions.length, 5, 20),
    detail: `${contradictions.length} distinct contradiction edges found`,
    topOffenders: recentEdges(contradictions, nodes, 5).map(edgeOffender),
  };
}

export function metricProjectSubgraphDensity(feed: GraphFeed): MetricResult {
  const projects = feed.nodes.filter((node) => node.kind === "wiki" && node.path.startsWith("wiki/projects/") && node.path.endsWith(".md"));
  if (projects.length === 0) {
    return metric({
      id: "graph.project-subgraph-density",
      label: "Project subgraph density",
      value: 0,
      unit: "ratio",
      threshold: { warn: 0.1, fail: 0.03, rule: "warn min < 0.10, fail min < 0.03" },
      status: "pass",
      detail: "no project wiki pages available for density measurement",
    });
  }

  const adjacency = adjacencyMap(feed.edges);
  const densities = projects.map((project) => {
    const reachable = bfs(project.path, adjacency, 2);
    const wikiReachable = new Set([...reachable].filter((path) => path.startsWith("wiki/")));
    const intra = feed.edges.filter((edge) => wikiReachable.has(edge.fromPath) && wikiReachable.has(edge.toPath)).length;
    const possible = Math.max(1, wikiReachable.size * (wikiReachable.size - 1));
    return {
      project,
      density: intra / possible,
      nodes: wikiReachable.size,
      intra,
    };
  }).sort((a, b) => a.density - b.density || a.project.path.localeCompare(b.project.path));

  const minDensity = densities[0]?.density ?? 0;

  return {
    id: "graph.project-subgraph-density",
    label: "Project subgraph density",
    value: round(minDensity, 3),
    unit: "ratio",
    threshold: { warn: 0.1, fail: 0.03, rule: "warn min < 0.10, fail min < 0.03" },
    status: statusBelow(minDensity, 0.1, 0.03),
    detail: `minimum 2-hop project density across ${projects.length} projects`,
    topOffenders: densities.slice(0, 3).map((entry) => ({
      path: entry.project.path,
      value: round(entry.density, 3),
      note: `${entry.intra} intra edges across ${entry.nodes} nodes`,
    })),
  };
}

export function metricAgentAttribution(input: GraphHealthInput): MetricResult {
  const pages = input.wikiPages;
  if (pages.length === 0) {
    return metric({
      id: "graph.agent-attribution",
      label: "Agent attribution",
      value: 0,
      unit: "%",
      threshold: { warn: 90, fail: 70, rule: "warn < 90%, fail < 70%" },
      status: "pass",
      detail: "no wiki pages available for agent attribution measurement",
    });
  }

  const covered = pages.filter((page) => hasKnownSource(page.source));
  const missing = pages.filter((page) => !hasKnownSource(page.source));
  const value = percentage(covered.length, pages.length);

  return {
    id: "graph.agent-attribution",
    label: "Agent attribution",
    value,
    unit: "%",
    threshold: { warn: 90, fail: 70, rule: "warn < 90%, fail < 70%" },
    status: statusBelow(value, 90, 70),
    detail: `${covered.length}/${pages.length} wiki pages have a non-empty source field`,
    topOffenders: missing.slice(0, 5).map((page) => ({
      path: page.relPath,
      note: "missing source",
    })),
  };
}

export function metricGraphParticipationRate(input: GraphHealthInput): MetricResult {
  const pages = input.wikiPages;
  if (pages.length === 0) {
    return metric({
      id: "graph.participation-rate",
      label: "Graph participation rate",
      value: 0,
      unit: "%",
      threshold: { warn: 50, fail: 25, rule: "warn < 50%, fail < 25%" },
      status: "pass",
      detail: "no wiki pages available for graph participation measurement",
    });
  }

  const participatingPaths = new Set<string>();
  for (const edge of input.feed.edges) {
    if (edge.fromPath.startsWith("wiki/")) participatingPaths.add(edge.fromPath);
    if (edge.toPath.startsWith("wiki/")) participatingPaths.add(edge.toPath);
  }

  const participating = pages.filter((page) => participatingPaths.has(page.relPath));
  const isolated = pages.filter((page) => !participatingPaths.has(page.relPath));
  const value = percentage(participating.length, pages.length);

  return {
    id: "graph.participation-rate",
    label: "Graph participation rate",
    value,
    unit: "%",
    threshold: { warn: 50, fail: 25, rule: "warn < 50%, fail < 25%" },
    status: statusBelow(value, 50, 25),
    detail: `${participating.length}/${pages.length} wiki pages participate in at least one edge (${value}%)`,
    topOffenders: randomSample(isolated, 5).map((page) => ({
      path: page.relPath,
      note: "isolated wiki page",
    })),
  };
}

export function metricNarrativeThreadCoverage(_feed: GraphFeed): MetricResult {
  return {
    id: "graph.narrative-thread-coverage",
    label: "Narrative thread coverage",
    value: null,
    threshold: { rule: "pending narrative threads in Phase 4" },
    status: "n/a",
    detail: "pending narrative threads in Phase 4",
    topOffenders: [],
  };
}

function metric(result: Omit<MetricResult, "topOffenders"> & { topOffenders?: Offender[] }): MetricResult {
  return {
    ...result,
    topOffenders: result.topOffenders ?? [],
  };
}

function statusAbove(value: number, warn: number, fail: number): HealthStatus {
  if (value > fail) return "fail";
  if (value > warn) return "warn";
  return "pass";
}

function statusBelow(value: number, warn: number, fail: number): HealthStatus {
  if (value < fail) return "fail";
  if (value < warn) return "warn";
  return "pass";
}

function statusAtLeast(value: number, warn: number, fail: number): HealthStatus {
  if (value >= fail) return "fail";
  if (value >= warn) return "warn";
  return "pass";
}

function worstStatus(statuses: HealthStatus[]): HealthStatus {
  const comparable = statuses.filter((status) => status !== "n/a");
  if (comparable.length === 0) return "n/a";
  return comparable.sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? "n/a";
}

function percentage(count: number, total: number): number {
  if (total === 0) return 0;
  return round((count / total) * 100, 2);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function degree(node: GraphNode | undefined): number {
  if (!node) return 0;
  return node.inboundCount + node.outboundCount;
}

function isExemptHub(path: string): boolean {
  return EXEMPT_HUB_PATTERNS.some((pattern) => pattern.test(path));
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasKnownSource(value: string | null | undefined): boolean {
  return hasText(value) && value !== "unknown";
}

function hasImportedFrom(value: WikiHealthPage["importedFrom"]): boolean {
  return Boolean(value && (hasText(value.system) || hasText(value.originalKey)));
}

function hasConfidenceMetadata(page: WikiHealthPage): boolean {
  return page.confidence !== null && page.confidence !== undefined ||
    page.confidenceFull !== null && page.confidenceFull !== undefined;
}

function nodeMap(feed: GraphFeed): Map<string, GraphNode> {
  return new Map(feed.nodes.map((node) => [node.path, node]));
}

function oldestNodes(nodes: GraphNode[], limit: number): GraphNode[] {
  return [...nodes]
    .sort((a, b) => timestamp(a, "oldest") - timestamp(b, "oldest") || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function recentWikiPages(pages: ReadonlyArray<WikiHealthPage>, limit: number): WikiHealthPage[] {
  return [...pages]
    .sort((a, b) => wikiPageTimestamp(b) - wikiPageTimestamp(a) || a.relPath.localeCompare(b.relPath))
    .slice(0, limit);
}

function wikiPageTimestamp(page: WikiHealthPage): number {
  const raw = page.updated ?? page.created;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recentEdges(edges: GraphEdge[], nodes: Map<string, GraphNode>, limit: number): GraphEdge[] {
  return [...edges]
    .sort((a, b) => edgeTimestamp(b, nodes) - edgeTimestamp(a, nodes) || edgeKey(a).localeCompare(edgeKey(b)))
    .slice(0, limit);
}

function timestamp(node: GraphNode, mode: "oldest" | "recent"): number {
  const fallback = mode === "oldest" ? Number.POSITIVE_INFINITY : 0;
  const raw = mode === "oldest" ? node.created ?? node.updated : node.updated ?? node.created;
  if (!raw) return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function edgeTimestamp(edge: GraphEdge, nodes: Map<string, GraphNode>): number {
  const raw = edge.validFrom ?? nodes.get(edge.fromPath)?.updated ?? nodes.get(edge.toPath)?.updated;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.fromPath}\0${edge.toPath}\0${edge.type}`;
}

function edgeOffender(edge: GraphEdge): Offender {
  return {
    edge: { from: edge.fromPath, to: edge.toPath, type: edge.type },
  };
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function capDistribution(counts: Map<string, number>, cap: number): Map<string, number> {
  if (counts.size <= cap) return counts;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = sorted.slice(0, cap - 1);
  const other = sorted.slice(cap - 1).reduce((sum, [, count]) => sum + count, 0);
  return new Map([...kept, ["other", other]]);
}

function normalizeTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const withoutStopWords = words.filter((part) => !STOP_WORDS.has(part));
  return (withoutStopWords.length > 0 ? withoutStopWords : words).join(" ");
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}

function forEachPair<T>(items: T[], callback: (left: T, right: T) => void): void {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      callback(items[i]!, items[j]!);
    }
  }
}

function addDuplicatePagePair(
  pairs: Map<string, { pair: [WikiHealthPage, WikiHealthPage]; similarity: number }>,
  left: WikiHealthPage,
  right: WikiHealthPage,
  similarity: number,
): void {
  const ordered: [WikiHealthPage, WikiHealthPage] = left.relPath.localeCompare(right.relPath) <= 0 ? [left, right] : [right, left];
  const key = `${ordered[0].relPath}\0${ordered[1].relPath}`;
  const existing = pairs.get(key);
  if (!existing || similarity > existing.similarity) {
    pairs.set(key, { pair: ordered, similarity });
  }
}

function randomSample<T>(items: ReadonlyArray<T>, limit: number): T[] {
  return [...items]
    .map((item) => ({ item, rank: Math.random() }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ item }) => item);
}

function adjacencyMap(edges: GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    addNeighbor(adjacency, edge.fromPath, edge.toPath);
    addNeighbor(adjacency, edge.toPath, edge.fromPath);
  }
  return adjacency;
}

function addNeighbor(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  const neighbors = adjacency.get(from) ?? new Set<string>();
  neighbors.add(to);
  adjacency.set(from, neighbors);
}

function bfs(seed: string, adjacency: Map<string, Set<string>>, hops: number): Set<string> {
  const visited = new Set([seed]);
  let frontier = new Set([seed]);

  for (let hop = 0; hop < hops && frontier.size > 0; hop += 1) {
    const next = new Set<string>();
    for (const path of frontier) {
      for (const neighbor of adjacency.get(path) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.add(neighbor);
      }
    }
    frontier = next;
  }

  return visited;
}
