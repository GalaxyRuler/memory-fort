import type { GraphEdge, GraphNode } from "../hooks/useGraph.js";

export interface PositionedNode {
  path: string;
  fx?: number;
  fy?: number;
  fz?: number;
}

export function computeOrbitalPositions(
  nodes: GraphNode[],
  edges: GraphEdge[],
  focalPath: string | null = null,
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const focal = focalPath
    ? nodes.find((node) => node.path === focalPath)
    : [...nodes].sort((a, b) => b.inboundCount - a.inboundCount)[0];
  if (!focal) return nodes.map((node) => ({ path: node.path }));

  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.path, new Set());
  for (const edge of edges) {
    adjacency.get(edge.fromPath)?.add(edge.toPath);
    adjacency.get(edge.toPath)?.add(edge.fromPath);
  }

  const hops = new Map<string, number>();
  hops.set(focal.path, 0);
  const queue = [focal.path];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const distance = hops.get(current) ?? 0;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!hops.has(neighbor)) {
        hops.set(neighbor, distance + 1);
        queue.push(neighbor);
      }
    }
  }

  const maxHop = Math.max(0, ...hops.values());
  for (const node of nodes) {
    if (!hops.has(node.path)) hops.set(node.path, maxHop + 1);
  }

  const groupedByHop = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const hop = hops.get(node.path) ?? 0;
    const group = groupedByHop.get(hop) ?? [];
    group.push(node);
    groupedByHop.set(hop, group);
  }

  const result: PositionedNode[] = [{ path: focal.path, fx: 0, fy: 0, fz: 0 }];
  for (const [hop, ring] of groupedByHop) {
    if (hop === 0) continue;
    const radius = hop * 60;
    const angleStep = (2 * Math.PI) / ring.length;
    ring.forEach((node, index) => {
      const angle = index * angleStep;
      const yOffset = (hop % 2 === 0 ? 1 : -1) * hop * 4;
      result.push({
        path: node.path,
        fx: Math.cos(angle) * radius,
        fy: yOffset,
        fz: Math.sin(angle) * radius,
      });
    });
  }

  return result;
}

export function computeTimelineFlowPositions(nodes: GraphNode[], now: Date = new Date()): PositionedNode[] {
  if (nodes.length === 0) return [];

  const ages = new Map<string, number>();
  for (const node of nodes) {
    if (!node.updated) {
      ages.set(node.path, 0);
      continue;
    }

    const parsed = Date.parse(node.updated);
    if (!Number.isFinite(parsed)) {
      ages.set(node.path, 0);
      continue;
    }

    const days = Math.max(0, Math.floor((now.getTime() - parsed) / (24 * 60 * 60 * 1000)));
    ages.set(node.path, days);
  }

  return nodes.map((node) => {
    const age = ages.get(node.path) ?? 0;
    const seed = hashString(node.path);
    const angle = ((seed % 1000) / 1000) * 2 * Math.PI;
    const radius = 30 + (seed % 50);
    return {
      path: node.path,
      fx: Math.cos(angle) * radius,
      fy: Math.sin(angle) * radius * 0.5,
      fz: -age * 8,
    };
  });
}

export function filterByTimelineScrubber(
  nodes: GraphNode[],
  maxAgeDays: number,
  now: Date = new Date(),
): Set<string> {
  const visible = new Set<string>();
  for (const node of nodes) {
    if (!node.updated) {
      visible.add(node.path);
      continue;
    }

    const parsed = Date.parse(node.updated);
    if (!Number.isFinite(parsed)) {
      visible.add(node.path);
      continue;
    }

    const days = (now.getTime() - parsed) / (24 * 60 * 60 * 1000);
    if (days <= maxAgeDays) visible.add(node.path);
  }
  return visible;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}
