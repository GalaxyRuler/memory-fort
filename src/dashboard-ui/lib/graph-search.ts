import type { GraphNode } from "../hooks/useGraph.js";

export function matchGraphNodes(nodes: GraphNode[], query: string): Set<string> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return new Set();

  const matches = new Set<string>();
  for (const node of nodes) {
    const title = node.title.toLowerCase();
    const path = node.path.toLowerCase();
    if (title.includes(normalizedQuery) || path.includes(normalizedQuery)) matches.add(node.path);
  }
  return matches;
}
