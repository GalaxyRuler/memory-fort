import { basename } from "node:path";
import type { SearchDocument } from "./corpus.js";

export type EdgeKind = "relation" | "wikilink";

export interface Edge {
  fromPath: string;
  toPath: string;
  kind: EdgeKind;
  relationType: string | null;
  validFrom?: string;
  validTo?: string | null;
  supersededBy?: string;
}

export interface GraphNode {
  path: string;
  outbound: Edge[];
  inbound: Edge[];
}

export interface SearchGraph {
  nodes: Map<string, GraphNode>;
  edges: Edge[];
  unresolvedTargets: Array<{ fromPath: string; raw: string; reason: string }>;
}

export interface GraphExpansionResult {
  expanded: Set<string>;
  pathToEdges: Map<string, Edge[]>;
}

export interface SpreadingActivationOptions {
  decay?: number;
  inhibitionLambda?: number;
  epsilon?: number;
  maxIterations?: number;
  followDirection?: "outbound" | "inbound" | "both";
  edgeWeights?: Record<string, number>;
}

export interface ActivationResult {
  path: string;
  activation: number;
}

type Resolution =
  | { path: string }
  | { path: null; reason: "ambiguous-filename" | "not-found" };

const WIKILINK_PATTERN = /\[\[([^\]\n]+)\]\]/g;
const SAFE_WIKILINK_TARGET = /^[A-Za-z0-9._/ -]+$/;
const DEFAULT_DECAY = 0.6;
const DEFAULT_INHIBITION_LAMBDA = 0.15;
const DEFAULT_EPSILON = 0.01;
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_EDGE_WEIGHTS: Record<string, number> = {};

export function buildGraph(documents: SearchDocument[]): SearchGraph {
  const nodes = new Map<string, GraphNode>();
  for (const document of documents) {
    nodes.set(document.relPath, {
      path: document.relPath,
      outbound: [],
      inbound: [],
    });
  }

  const resolver = createResolver(documents);
  const edges: Edge[] = [];
  const edgeKeys = new Set<string>();
  const unresolvedTargets: SearchGraph["unresolvedTargets"] = [];

  function addResolvedEdge(edge: Edge): void {
    const key = `${edge.fromPath}\0${edge.toPath}\0${edge.kind}\0${edge.relationType ?? ""}\0${edge.validFrom ?? ""}\0${edge.validTo ?? ""}\0${edge.supersededBy ?? ""}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
    nodes.get(edge.fromPath)?.outbound.push(edge);
    nodes.get(edge.toPath)?.inbound.push(edge);
  }

  function addTarget(fromPath: string, raw: string, kind: EdgeKind, relationType: string | null, metadata: Partial<Edge> = {}): void {
    const resolution = resolver(raw);
    if (resolution.path !== null) {
      addResolvedEdge({
        fromPath,
        toPath: resolution.path,
        kind,
        relationType,
        ...metadata,
      });
      return;
    }
    unresolvedTargets.push({ fromPath, raw: raw.trim(), reason: resolution.reason });
  }

  for (const document of documents) {
    for (const [relationType, targets] of Object.entries(document.relations)) {
      for (const edge of targets) {
        const target = typeof edge === "string" ? edge : edge.target;
        addTarget(document.relPath, target, "relation", relationType, typeof edge === "string"
          ? {}
          : {
              validFrom: edge.valid_from,
              validTo: edge.valid_to,
              supersededBy: edge.superseded_by,
            });
      }
    }

    for (const match of document.body.matchAll(WIKILINK_PATTERN)) {
      const target = match[1]?.trim() ?? "";
      if (!SAFE_WIKILINK_TARGET.test(target)) continue;
      addTarget(document.relPath, target, "wikilink", null);
    }
  }

  return { nodes, edges, unresolvedTargets };
}

export function expandGraph(
  seed: Set<string>,
  graph: SearchGraph,
  opts: { hops?: number; followDirection?: "outbound" | "inbound" | "both" } = {},
): GraphExpansionResult {
  const hops = opts.hops ?? 1;
  const followDirection = opts.followDirection ?? "both";
  const expanded = new Set<string>();
  const pathToEdges = new Map<string, Edge[]>();
  let frontier = new Set(seed);

  for (let hop = 0; hop < hops && frontier.size > 0; hop += 1) {
    const next = new Set<string>();
    for (const path of frontier) {
      const node = graph.nodes.get(path);
      if (!node) continue;
      const traversable = [
        ...(followDirection === "outbound" || followDirection === "both"
          ? node.outbound
          : []),
        ...(followDirection === "inbound" || followDirection === "both"
          ? node.inbound
          : []),
      ];

      for (const edge of traversable) {
        const neighbor = edge.fromPath === path ? edge.toPath : edge.fromPath;
        if (seed.has(neighbor) || expanded.has(neighbor)) continue;
        next.add(neighbor);
        const edges = pathToEdges.get(neighbor) ?? [];
        edges.push(edge);
        pathToEdges.set(neighbor, edges);
      }
    }

    for (const path of next) expanded.add(path);
    frontier = next;
  }

  return { expanded, pathToEdges };
}

export function spreadingActivation(
  seeds: Set<string>,
  graph: SearchGraph,
  opts: SpreadingActivationOptions = {},
): ActivationResult[] {
  const decay = opts.decay ?? DEFAULT_DECAY;
  const inhibitionLambda =
    opts.inhibitionLambda ?? DEFAULT_INHIBITION_LAMBDA;
  const epsilon = opts.epsilon ?? DEFAULT_EPSILON;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const followDirection = opts.followDirection ?? "both";
  const edgeWeights = opts.edgeWeights ?? DEFAULT_EDGE_WEIGHTS;
  const activations = new Map<string, number>();
  const visited = new Set<string>();
  let frontier = new Map<string, number>();

  for (const seed of seeds) {
    if (!graph.nodes.has(seed)) continue;
    activations.set(seed, 1);
    visited.add(seed);
    frontier.set(seed, 1);
  }

  for (
    let iteration = 0;
    iteration < maxIterations && frontier.size > 0;
    iteration += 1
  ) {
    const rawNext = new Map<string, number>();
    const siblingContributions = new Map<string, Map<string, number>>();

    for (const [path, activation] of frontier) {
      const node = graph.nodes.get(path);
      if (!node) continue;
      for (const edge of traversableEdges(node, followDirection)) {
        const neighbor = edge.fromPath === path ? edge.toPath : edge.fromPath;
        if (visited.has(neighbor)) continue;
        const contribution =
          activation * edgeWeight(edge, edgeWeights) * decay;
        rawNext.set(neighbor, (rawNext.get(neighbor) ?? 0) + contribution);

        const siblings =
          siblingContributions.get(path) ?? new Map<string, number>();
        siblings.set(neighbor, (siblings.get(neighbor) ?? 0) + contribution);
        siblingContributions.set(path, siblings);
      }
    }

    if (rawNext.size === 0) break;

    const penalties = siblingPenalties(
      siblingContributions,
      inhibitionLambda,
    );
    const nextFrontier = new Map<string, number>();
    for (const [path, rawActivation] of rawNext) {
      const activation = Math.max(
        0,
        rawActivation - (penalties.get(path) ?? 0),
      );
      if (activation <= epsilon) continue;
      activations.set(path, activation);
      nextFrontier.set(path, activation);
    }

    if (nextFrontier.size === 0) break;
    for (const path of nextFrontier.keys()) visited.add(path);
    frontier = nextFrontier;
  }

  return [...activations.entries()]
    .map(([path, activation]) => ({ path, activation }))
    .sort((a, b) => b.activation - a.activation || a.path.localeCompare(b.path));
}

function createResolver(documents: SearchDocument[]): (target: string) => Resolution {
  const exact = new Map<string, Set<string>>();
  const byFilename = new Map<string, Set<string>>();

  for (const document of documents) {
    for (const form of pathForms(document.relPath)) {
      addToIndex(exact, form, document.relPath);
    }
    addToIndex(byFilename, slug(document.relPath), document.relPath);
  }

  return (target: string): Resolution => {
    const normalized = stripMd(target.trim());
    for (const form of [normalized, `${normalized}.md`]) {
      const exactMatches = exact.get(form);
      if (exactMatches?.size === 1) {
        return { path: [...exactMatches][0]! };
      }
      if (exactMatches && exactMatches.size > 1) {
        return { path: null, reason: "ambiguous-filename" };
      }
    }

    const filenameMatches = byFilename.get(slug(normalized));
    if (filenameMatches?.size === 1) {
      return { path: [...filenameMatches][0]! };
    }
    if (filenameMatches && filenameMatches.size > 1) {
      return { path: null, reason: "ambiguous-filename" };
    }
    return { path: null, reason: "not-found" };
  };
}

function pathForms(relPath: string): string[] {
  const withoutExtension = stripMd(relPath);
  const forms = [relPath, withoutExtension];
  const withoutTopLevel = withoutExtension.split("/").slice(1).join("/");
  if (withoutTopLevel.length > 0) {
    forms.push(withoutTopLevel, `${withoutTopLevel}.md`);
  }
  return forms;
}

function slug(path: string): string {
  return stripMd(basename(path));
}

function stripMd(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function addToIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(value);
  index.set(key, values);
}

function traversableEdges(
  node: GraphNode,
  followDirection: "outbound" | "inbound" | "both",
): Edge[] {
  return [
    ...(followDirection === "outbound" || followDirection === "both"
      ? node.outbound
      : []),
    ...(followDirection === "inbound" || followDirection === "both"
      ? node.inbound
      : []),
  ];
}

function edgeWeight(edge: Edge, edgeWeights: Record<string, number>): number {
  if (edge.relationType && edgeWeights[edge.relationType] !== undefined) {
    return edgeWeights[edge.relationType]!;
  }
  if (edgeWeights[edge.kind] !== undefined) {
    return edgeWeights[edge.kind]!;
  }
  return 1;
}

function siblingPenalties(
  siblingContributions: Map<string, Map<string, number>>,
  inhibitionLambda: number,
): Map<string, number> {
  const penalties = new Map<string, number>();
  if (inhibitionLambda <= 0) return penalties;

  for (const siblings of siblingContributions.values()) {
    if (siblings.size <= 1) continue;
    for (const [path] of siblings) {
      const maxCompetitor = Math.max(
        ...[...siblings.entries()]
          .filter(([siblingPath]) => siblingPath !== path)
          .map(([, activation]) => activation),
      );
      penalties.set(
        path,
        (penalties.get(path) ?? 0) + inhibitionLambda * maxCompetitor,
      );
    }
  }

  return penalties;
}
