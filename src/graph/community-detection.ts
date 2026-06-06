export interface CommunityDetectionOptions {
  minClusterSize?: number;
  maxIterations?: number;
}

export interface CommunityCluster {
  id: string;
  members: string[];
}

const DEFAULT_MIN_CLUSTER_SIZE = 2;
const DEFAULT_MAX_ITERATIONS = 20;

export function detectCommunities(
  adjacency: Record<string, Set<string> | string[]>,
  opts: CommunityDetectionOptions = {},
): CommunityCluster[] {
  const graph = normalizeAdjacency(adjacency);
  const nodes = [...graph.keys()].sort((a, b) => a.localeCompare(b));
  const labels = new Map(nodes.map((node) => [node, node]));
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false;
    for (const node of nodes) {
      const next = bestNeighborLabel(node, graph, labels);
      if (next && next !== labels.get(node)) {
        labels.set(node, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const byLabel = new Map<string, string[]>();
  for (const node of nodes) {
    const label = labels.get(node) ?? node;
    byLabel.set(label, [...(byLabel.get(label) ?? []), node]);
  }

  const minClusterSize = Math.max(2, opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);
  return [...byLabel.values()]
    .map((members) => members.sort((a, b) => a.localeCompare(b)))
    .filter((members) => members.length >= minClusterSize)
    .map((members) => ({ id: members[0]!, members }))
    .sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
}

function normalizeAdjacency(adjacency: Record<string, Set<string> | string[]>): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [node, neighbors] of Object.entries(adjacency)) {
    ensureNode(graph, node);
    for (const neighbor of neighbors) {
      if (neighbor === node) continue;
      addUndirected(graph, node, neighbor);
    }
  }
  return graph;
}

function bestNeighborLabel(
  node: string,
  graph: Map<string, Set<string>>,
  labels: Map<string, string>,
): string | null {
  const counts = new Map<string, number>();
  for (const neighbor of graph.get(node) ?? []) {
    const label = labels.get(neighbor) ?? neighbor;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function ensureNode(graph: Map<string, Set<string>>, node: string): void {
  if (!graph.has(node)) graph.set(node, new Set());
}

function addUndirected(graph: Map<string, Set<string>>, left: string, right: string): void {
  ensureNode(graph, left);
  ensureNode(graph, right);
  graph.get(left)!.add(right);
  graph.get(right)!.add(left);
}
