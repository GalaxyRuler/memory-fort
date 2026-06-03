import type { GraphFeed } from "./loaders.js";
import {
  edgeClass,
  isAssociationEdge,
  isProvenanceEdge,
  isReasoningEdge,
} from "../retrieval/edge-classes.js";
import type { RelationMap } from "../retrieval/relations.js";
import { isEntityWikiPath } from "../retrieval/wiki-paths.js";

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
  now?: Date | string | null;
}

export interface WikiHealthPage {
  relPath: string;
  title: string;
  source?: string | null;
  confidence?: number | object | null;
  confidenceFull?: unknown;
  created?: string | null;
  updated?: string | null;
  relations?: RelationMap;
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
// Calibrated against Memory Fort's consolidation-heavy graph shape on
// 2026-05-27: raw episodic/semantic nodes linking to wiki semantic/core pages
// produce about 98% cross-galaxy edges as the architectural norm. These
// thresholds catch near-total crossings without false-alarming on consolidation.
const CROSS_GALAXY_WARN = 99;
const CROSS_GALAXY_FAIL = 99.5;
const NARRATIVE_THREAD_WINDOW_DAYS = 30;
const SALIENT_EPISODE_WINDOW_DAYS = 30;
const SALIENT_IMPORTANCE_THRESHOLD = 4;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeGraphHealth(input: GraphHealthInput): GraphHealthReport {
  const { feed } = input;
  const metrics = [
    metricOrphanEpisodic(feed),
    metricSalientEpisodeAnchorRate(input),
    metricDuplicateEntities(input),
    metricEdgeTypeEntropy(feed),
    metricCrossGalaxyRatio(feed),
    metricHubOverload(feed),
    metricTemporalCoverage(feed),
    metricProvenanceCoverage(input),
    metricProvenanceEdgeCoverage(feed),
    metricAssociationEdgeCoverage(feed),
    metricConfidenceCoverage(input),
    metricContradictionCoverage(feed),
    metricProjectSubgraphDensity(feed),
    metricAgentAttribution(input),
    metricGraphParticipationRate(input),
    metricNarrativeThreadCoverage(input),
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
    threshold: { rule: "informational all-raw rate; see graph.salient-episode-anchor-rate for health" },
    status: "pass",
    detail: `${orphaned.length}/${episodic.length} raw observations have no relation edges (informational all-raw rate)`,
    topOffenders: oldestNodes(orphaned, 5).map((node) => ({
      path: node.path,
      value: node.created ?? node.updated ?? "unknown",
      note: "orphan raw observation",
    })),
  };
}

export function metricSalientEpisodeAnchorRate(input: GraphHealthInput): MetricResult {
  const rawNodes = input.feed.nodes.filter((node) => node.kind === "raw");
  const rawWindow = trailingRawWindow(input, rawNodes, SALIENT_EPISODE_WINDOW_DAYS);
  const salient = rawWindow.nodes.filter((node) => readImportance(node) >= SALIENT_IMPORTANCE_THRESHOLD);
  if (salient.length === 0) {
    return metric({
      id: "graph.salient-episode-anchor-rate",
      label: "Salient episode anchor rate",
      value: null,
      unit: "%",
      threshold: { warn: 75, fail: 50, rule: "pass >= 75%, warn >= 50%, fail < 50%" },
      status: "n/a",
      detail: `no salient recent raw observations in trailing ${rawWindow.days}-day window`,
    });
  }

  const anchoredRaw = semanticAnchoredRawPaths(input.feed.edges);
  const anchored = salient.filter((node) => anchoredRaw.has(node.path));
  const value = percentage(anchored.length, salient.length);

  return {
    id: "graph.salient-episode-anchor-rate",
    label: "Salient episode anchor rate",
    value,
    unit: "%",
    threshold: { warn: 75, fail: 50, rule: "pass >= 75%, warn >= 50%, fail < 50%" },
    status: statusBelow(value, 75, 50),
    detail: `${anchored.length}/${salient.length} salient recent raw observations have semantic anchors (importance >= ${SALIENT_IMPORTANCE_THRESHOLD}, trailing ${rawWindow.days}-day window ending ${rawWindow.upperDay})`,
    topOffenders: oldestNodes(salient.filter((node) => !anchoredRaw.has(node.path)), 5).map((node) => ({
      path: node.path,
      value: readImportance(node),
      note: "salient raw observation without semantic anchor",
    })),
  };
}

export function metricDuplicateEntities(input: GraphHealthInput): MetricResult {
  const normalized = graphHealthWikiPages(input).map((page) => ({
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
  const edges = feed.edges.filter(isReasoningEdge);
  if (edges.length === 0) {
    return metric({
      id: "graph.edge-type-entropy",
      label: "Edge type entropy",
      value: 0,
      unit: "bits",
      threshold: { warn: 0.8, fail: 0.4, rule: "warn < 0.8 bits, fail < 0.4 bits" },
      status: "pass",
      detail: "no reasoning edges available for entropy measurement",
    });
  }

  const counts = countBy(edges, (edge) => edge.type);
  const capped = capDistribution(counts, 9);
  const entropy = [...capped.values()].reduce((sum, count) => {
    const p = count / edges.length;
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
    detail: `Shannon entropy across ${edges.length} reasoning edges and ${counts.size} edge types`,
    topOffenders: dominant.map(([type, count]) => ({
      value: `${round((count / edges.length) * 100, 1).toFixed(1)}%`,
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
    threshold: { warn: CROSS_GALAXY_WARN, fail: CROSS_GALAXY_FAIL, rule: "warn > 99%, fail > 99.5%" },
    status: statusAbove(value, CROSS_GALAXY_WARN, CROSS_GALAXY_FAIL),
    detail: `${value}% (${cross.length}/${feed.edges.length}) edges connect different cognitive galaxies${topCrossings ? `; top crossings: ${topCrossings}` : ""}`,
    topOffenders: recentEdges(cross, nodes, 5).map(edgeOffender),
  };
}

export function metricHubOverload(feed: GraphFeed): MetricResult {
  const degreeByPath = degreeMap(feed.edges.filter(isReasoningEdge));
  const allNodes = feed.nodes.map((node) => ({
    node,
    degree: degreeByPath.get(node.path)?.total ?? 0,
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
          ? `exempt (${PROJECT_HUB_EXEMPTION_REASON}); ${degreeByPath.get(entry.node.path)?.inbound ?? 0} inbound, ${degreeByPath.get(entry.node.path)?.outbound ?? 0} outbound`
          : `${degreeByPath.get(entry.node.path)?.inbound ?? 0} inbound, ${degreeByPath.get(entry.node.path)?.outbound ?? 0} outbound`,
        exempt: entry.exempt || undefined,
        reason: entry.exempt ? PROJECT_HUB_EXEMPTION_REASON : undefined,
      })),
  };
}

export function metricProvenanceEdgeCoverage(feed: GraphFeed): MetricResult {
  const edges = feed.edges.filter(isProvenanceEdge);
  const value = percentage(edges.length, feed.edges.length);
  return metric({
    id: "graph.provenance-edge-coverage",
    label: "Provenance edge share",
    value,
    unit: "%",
    threshold: { rule: "informational" },
    status: "pass",
    detail: `${edges.length}/${feed.edges.length} edges are provenance edges`,
  });
}

export function metricAssociationEdgeCoverage(feed: GraphFeed): MetricResult {
  const edges = feed.edges.filter(isAssociationEdge);
  const value = percentage(edges.length, feed.edges.length);
  return metric({
    id: "graph.association-edge-coverage",
    label: "Association edge share",
    value,
    unit: "%",
    threshold: { rule: "informational" },
    status: "pass",
    detail: `${edges.length}/${feed.edges.length} edges are association edges`,
  });
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
  const pages = graphHealthWikiPages(input);
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
  const pages = graphHealthWikiPages(input);
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

  const reasoningEdges = feed.edges.filter(isReasoningEdge);
  const adjacency = adjacencyMap(reasoningEdges);
  const densities = projects.map((project) => {
    const reachable = bfs(project.path, adjacency, 2);
    const wikiReachable = new Set([...reachable].filter((path) => path.startsWith("wiki/")));
    const intra = reasoningEdges.filter((edge) => wikiReachable.has(edge.fromPath) && wikiReachable.has(edge.toPath)).length;
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
    detail: `minimum 2-hop project density across ${projects.length} projects using reasoning edges`,
    topOffenders: densities.slice(0, 3).map((entry) => ({
      path: entry.project.path,
      value: round(entry.density, 3),
      note: `${entry.intra} intra edges across ${entry.nodes} nodes`,
    })),
  };
}

export function metricAgentAttribution(input: GraphHealthInput): MetricResult {
  const pages = graphHealthWikiPages(input);
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
  const pages = graphHealthWikiPages(input);
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
  for (const edge of input.feed.edges.filter(isReasoningEdge)) {
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
    detail: `${participating.length}/${pages.length} wiki pages participate in at least one reasoning edge (${value}%)`,
    topOffenders: randomSample(isolated, 5).map((page) => ({
      path: page.relPath,
      note: "isolated wiki page",
    })),
  };
}

export function metricNarrativeThreadCoverage(input: GraphHealthInput): MetricResult {
  const threadPages = graphHealthWikiPages(input).filter(isLiveNarrativeThread);
  if (threadPages.length === 0) {
    return {
      id: "graph.narrative-thread-coverage",
      label: "Narrative thread coverage",
      value: null,
      threshold: { rule: "n/a until first thread authored" },
      status: "n/a",
      detail: "no narrative threads in vault yet",
      topOffenders: [],
    };
  }

  const rawNodes = input.feed.nodes.filter((node) => node.kind === "raw");
  const rawWindow = trailingRawWindow(input, rawNodes, NARRATIVE_THREAD_WINDOW_DAYS);
  if (rawWindow.nodes.length === 0) {
    return {
      id: "graph.narrative-thread-coverage",
      label: "Narrative thread coverage",
      value: null,
      threshold: { warn: 50, fail: 25, rule: "pass >= 50%, warn >= 25%, fail < 25%" },
      status: "n/a",
      detail: "no raw observations in window",
      topOffenders: [],
    };
  }

  const rawWindowPaths = new Set(rawWindow.nodes.map((node) => node.path));
  const referencedRawPaths = new Set<string>();
  for (const page of threadPages) {
    for (const relations of Object.values(page.relations ?? {})) {
      for (const relation of relations) {
        if (rawWindowPaths.has(relation.target)) {
          referencedRawPaths.add(relation.target);
        }
      }
    }
  }

  const coverage = (referencedRawPaths.size / rawWindow.nodes.length) * 100;
  const value = round(coverage, 2);

  return {
    id: "graph.narrative-thread-coverage",
    label: "Narrative thread coverage",
    value,
    unit: "%",
    threshold: { warn: 50, fail: 25, rule: "pass >= 50%, warn >= 25%, fail < 25%" },
    status: coverage < 25 ? "fail" : coverage < 50 ? "warn" : "pass",
    detail: `${referencedRawPaths.size}/${rawWindow.nodes.length} raw observations referenced by ${threadPages.length} thread(s) in trailing ${rawWindow.days}-day window ending ${rawWindow.upperDay} (${coverage.toFixed(1)}%)`,
    topOffenders: [],
  };
}

function trailingRawWindow(
  input: GraphHealthInput,
  rawNodes: GraphNode[],
  days: number,
): { nodes: GraphNode[]; upperDay: string; days: number } {
  const rawDateByPath = new Map(
    rawNodes.map((node) => [node.path, rawObservationDay(node)] as const),
  );
  const upperDay = inputDay(input.now) ?? maxDateOnly([...rawDateByPath.values()]);
  if (!upperDay) return { nodes: [], upperDay: "unknown", days };

  return {
    nodes: rawNodes.filter((node) => {
      const day = rawDateByPath.get(node.path);
      return Boolean(day && isWithinTrailingDays(day, upperDay, days));
    }),
    upperDay,
    days,
  };
}

function inputDay(value: GraphHealthInput["now"]): string | null {
  if (value instanceof Date) return normalizeDateOnly(value.toISOString());
  if (typeof value === "string") return normalizeDateOnly(value);
  return null;
}

function rawObservationDay(node: GraphNode): string | null {
  return normalizeDateOnly(node.created) ?? dateFromPath(node.path) ?? normalizeDateOnly(node.updated);
}

function dateFromPath(path: string): string | null {
  const match = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?=[^0-9]|$)/.exec(path);
  return normalizeDateOnly(match?.[1]);
}

function maxDateOnly(values: Array<string | null>): string | null {
  return values
    .filter((value): value is string => value !== null)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
}

function isWithinTrailingDays(day: string, upperDay: string, days: number): boolean {
  const timestamp = dateOnlyUtcMs(day);
  const upper = dateOnlyUtcMs(upperDay);
  const lower = upper - Math.max(0, days) * MS_PER_DAY;
  return timestamp >= lower && timestamp <= upper;
}

function normalizeDateOnly(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value?.trim() ?? "");
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return match[0];
}

function dateOnlyUtcMs(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1);
}

function isLiveNarrativeThread(page: WikiHealthPage): boolean {
  return page.relPath.startsWith("wiki/threads/") && !page.relPath.includes("/archive/");
}

function graphHealthWikiPages(input: GraphHealthInput): WikiHealthPage[] {
  return input.wikiPages.filter((page) => isEntityWikiPath(page.relPath));
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

function degreeMap(edges: GraphEdge[]): Map<string, { inbound: number; outbound: number; total: number }> {
  const degrees = new Map<string, { inbound: number; outbound: number; total: number }>();
  for (const edge of edges) {
    const from = degrees.get(edge.fromPath) ?? { inbound: 0, outbound: 0, total: 0 };
    from.outbound += 1;
    from.total += 1;
    degrees.set(edge.fromPath, from);

    const to = degrees.get(edge.toPath) ?? { inbound: 0, outbound: 0, total: 0 };
    to.inbound += 1;
    to.total += 1;
    degrees.set(edge.toPath, to);
  }
  return degrees;
}

function semanticAnchoredRawPaths(edges: GraphEdge[]): Set<string> {
  const anchored = new Set<string>();
  for (const edge of edges) {
    if (edgeClass(edge) === "association") continue;
    const fromRaw = edge.fromPath.startsWith("raw/");
    const toRaw = edge.toPath.startsWith("raw/");
    const fromWiki = edge.fromPath.startsWith("wiki/");
    const toWiki = edge.toPath.startsWith("wiki/");
    if (fromRaw && toWiki) anchored.add(edge.fromPath);
    if (toRaw && fromWiki) anchored.add(edge.toPath);
  }
  return anchored;
}

function readImportance(node: GraphNode): number {
  return typeof node.importance === "number" && Number.isFinite(node.importance)
    ? node.importance
    : 0;
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
