import type { GraphEdge } from "../hooks/useGraph.js";

export interface GraphPath {
  nodes: string[];
  edgePairs: Array<[string, string]>;
}

interface Neighbor {
  path: string;
  edgePair: [string, string];
}

export function shortestPath(edges: GraphEdge[], from: string, to: string): GraphPath | null {
  if (from === to) return { nodes: [from], edgePairs: [] };

  const adjacency = buildAdjacency(edges);
  const queue = [from];
  const previous = new Map<string, { path: string; edgePair: [string, string] }>();
  const visited = new Set([from]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor.path)) continue;

      visited.add(neighbor.path);
      previous.set(neighbor.path, { path: current, edgePair: neighbor.edgePair });
      if (neighbor.path === to) return buildPath(previous, from, to);
      queue.push(neighbor.path);
    }
  }

  return null;
}

export function twoHopNeighborhood(edges: GraphEdge[], origin: string): Set<string> {
  const adjacency = buildAdjacency(edges);
  const visited = new Set([origin]);
  const queue: Array<{ path: string; distance: number }> = [{ path: origin, distance: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.distance >= 2) continue;

    for (const neighbor of adjacency.get(current.path) ?? []) {
      if (visited.has(neighbor.path)) continue;
      visited.add(neighbor.path);
      queue.push({ path: neighbor.path, distance: current.distance + 1 });
    }
  }

  return visited;
}

function buildAdjacency(edges: GraphEdge[]): Map<string, Neighbor[]> {
  const adjacency = new Map<string, Neighbor[]>();

  for (const edge of edges) {
    const edgePair: [string, string] = [edge.fromPath, edge.toPath];
    const fromNeighbors = adjacency.get(edge.fromPath) ?? [];
    fromNeighbors.push({ path: edge.toPath, edgePair });
    adjacency.set(edge.fromPath, fromNeighbors);

    const toNeighbors = adjacency.get(edge.toPath) ?? [];
    toNeighbors.push({ path: edge.fromPath, edgePair });
    adjacency.set(edge.toPath, toNeighbors);
  }

  return adjacency;
}

function buildPath(
  previous: Map<string, { path: string; edgePair: [string, string] }>,
  from: string,
  to: string,
): GraphPath | null {
  const nodes = [to];
  const edgePairs: Array<[string, string]> = [];
  let current = to;

  while (current !== from) {
    const step = previous.get(current);
    if (!step) return null;
    nodes.push(step.path);
    edgePairs.push(step.edgePair);
    current = step.path;
  }

  return { nodes: nodes.reverse(), edgePairs: edgePairs.reverse() };
}
