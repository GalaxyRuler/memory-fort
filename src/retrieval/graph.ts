import { basename } from "node:path";
import type { SearchDocument } from "./corpus.js";

export type EdgeKind = "relation" | "wikilink";

export interface Edge {
  fromPath: string;
  toPath: string;
  kind: EdgeKind;
  relationType: string | null;
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

type Resolution =
  | { path: string }
  | { path: null; reason: "ambiguous-filename" | "not-found" };

const WIKILINK_PATTERN = /\[\[([^\]\n]+)\]\]/g;
const SAFE_WIKILINK_TARGET = /^[A-Za-z0-9._/ -]+$/;

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
    const key = `${edge.fromPath}\0${edge.toPath}\0${edge.kind}\0${edge.relationType ?? ""}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
    nodes.get(edge.fromPath)?.outbound.push(edge);
    nodes.get(edge.toPath)?.inbound.push(edge);
  }

  function addTarget(
    fromPath: string,
    raw: string,
    kind: EdgeKind,
    relationType: string | null,
  ): void {
    const resolution = resolver(raw);
    if (resolution.path) {
      addResolvedEdge({
        fromPath,
        toPath: resolution.path,
        kind,
        relationType,
      });
      return;
    }
    unresolvedTargets.push({ fromPath, raw: raw.trim(), reason: resolution.reason });
  }

  for (const document of documents) {
    for (const [relationType, targets] of Object.entries(document.relations)) {
      for (const target of targets) {
        addTarget(document.relPath, target, "relation", relationType);
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
