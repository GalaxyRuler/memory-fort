import type { CognitiveType, GraphEdge, GraphNode } from "../../hooks/useGraph.js";
import { edgeWeight, type Point } from "./physics.js";

export type DomainType =
  | "projects"
  | "issues"
  | "decisions"
  | "lessons"
  | "references"
  | "tools"
  | "crystals"
  | "raw"
  | "other";

export const COGNITIVE_ORDER: CognitiveType[] = ["core", "semantic", "episodic", "procedural"];
export const DOMAIN_ORDER: DomainType[] = ["projects", "issues", "decisions", "lessons", "references", "tools", "crystals", "raw", "other"];

export const GALAXY_RADIUS = 900;
export const SYSTEM_RADIUS = 310;
export const PLANET_RADIUS = 130;

export const COGNITIVE_META: Record<CognitiveType, { color: string; label: string; speed: number }> = {
  core: { color: "#f0f6fc", label: "Core", speed: 0.00015 },
  semantic: { color: "#58a6ff", label: "Semantic", speed: 0.0003 },
  episodic: { color: "#f59e0b", label: "Episodic", speed: 0.00075 },
  procedural: { color: "#3fb950", label: "Procedural", speed: 0.0005 },
};

export const DOMAIN_META: Record<DomainType, { color: string; label: string }> = {
  projects: { color: "#4ade80", label: "Projects" },
  issues: { color: "#fb7185", label: "Issues" },
  decisions: { color: "#f472b6", label: "Decisions" },
  lessons: { color: "#a78bfa", label: "Lessons" },
  references: { color: "#60a5fa", label: "References" },
  tools: { color: "#fbbf24", label: "Tools" },
  crystals: { color: "#22d3ee", label: "Crystals" },
  raw: { color: "#fb923c", label: "Raw" },
  other: { color: "#94a3b8", label: "Other" },
};

export interface SandParticle {
  angle: number;
  r: number;
  speed: number;
  size: number;
  hue: string;
}

export interface GalacticGalaxy {
  id: CognitiveType;
  cx: number;
  cy: number;
  cz: number;
  color: string;
  label: string;
  spinSpeed: number;
  spin: number;
  systems: Partial<Record<DomainType, GalacticSystem>>;
  members: string[];
  sandSwarm: SandParticle[];
}

export interface GalacticSystem {
  id: DomainType;
  cognitiveType: CognitiveType;
  angle: number;
  cx: number;
  cy: number;
  cz: number;
  color: string;
  label: string;
  members: GalacticNode[];
}

export interface GalacticNode extends GraphNode {
  id: string;
  domain: DomainType;
  galaxy: GalacticGalaxy;
  system: GalacticSystem;
  mass: number;
  localOrbitR: number;
  localSpeed: number;
  localAngleSeed: number;
  size: number;
  x: number;
  y: number;
  z: number;
  localAngle: number;
  localPolarAngle: number;
}

export interface GalacticEdge {
  source: GalacticNode;
  target: GalacticNode;
  kind: GraphEdge["kind"];
  relationType: string | null;
  type: string;
  validFrom?: string;
  validTo?: string | null;
  supersededBy?: string;
  weight: number;
}

export interface GalacticLayout {
  galaxies: Record<CognitiveType, GalacticGalaxy>;
  nodes: GalacticNode[];
  edges: GalacticEdge[];
}

export function buildGalacticLayout(nodes: GraphNode[], edges: GraphEdge[] = []): GalacticLayout {
  const galaxies = createGalaxies();
  const layoutNodes: GalacticNode[] = [];

  for (const graphNode of nodes) {
    const cognitiveType = graphNode.cognitiveType ?? "semantic";
    const domain = normalizeDomain(graphNode);
    // Guard: a node may carry a cognitiveType with no galaxy (e.g. "prospective"
    // is a valid cognitive class in the data model but has no ring slot). Fall
    // back to the semantic galaxy instead of indexing undefined and crashing.
    const galaxy = galaxies[cognitiveType] ?? galaxies.semantic;
    const system = ensureSystem(galaxy, domain);
    const orbit = planetRadiusForMass(graphNode.inboundCount, system.members.length);
    const seed = seededUnit(graphNode.path, 1) * Math.PI * 2;
    const polarAngle = Math.acos(1 - 2 * seededUnit(graphNode.path, 6));
    const galacticNode: GalacticNode = {
      ...graphNode,
      id: graphNode.path,
      domain,
      galaxy,
      system,
      mass: orbit.mass,
      localOrbitR: orbit.localOrbitR,
      localSpeed: 0.00035 + seededUnit(graphNode.path, 2) * 0.0006,
      localAngleSeed: seed,
      localPolarAngle: polarAngle,
      size: orbit.size,
      x: system.cx,
      y: system.cy,
      z: system.cz,
      localAngle: seed,
    };
    galaxy.members.push(graphNode.path);
    system.members.push(galacticNode);
    layoutNodes.push(galacticNode);
  }

  const byPath = new Map(layoutNodes.map((node) => [node.path, node]));
  const layoutEdges = edges.flatMap((edge): GalacticEdge[] => {
    const source = byPath.get(edge.fromPath);
    const target = byPath.get(edge.toPath);
    if (!source || !target) return [];
    return [{
      source,
      target,
      kind: edge.kind,
      relationType: edge.relationType,
      type: edge.type,
      validFrom: edge.validFrom,
      validTo: edge.validTo,
      supersededBy: edge.supersededBy,
      weight: edgeWeight(source.inboundCount, target.inboundCount),
    }];
  });

  updateGalacticPositions(layoutNodes, 0);
  return { galaxies, nodes: layoutNodes, edges: layoutEdges };
}

const TETRA_VERTICES: [number, number, number][] = [
  [0, 1, 0],
  [Math.sqrt(8 / 9), -1 / 3, 0],
  [-Math.sqrt(2 / 9), -1 / 3, Math.sqrt(2 / 3)],
  [-Math.sqrt(2 / 9), -1 / 3, -Math.sqrt(2 / 3)],
];

export function createGalaxies(): Record<CognitiveType, GalacticGalaxy> {
  const entries = COGNITIVE_ORDER.map((cognitiveType, index) => {
    const [tx, ty, tz] = TETRA_VERTICES[index]!;
    const meta = COGNITIVE_META[cognitiveType];
    const galaxy: GalacticGalaxy = {
      id: cognitiveType,
      cx: tx * GALAXY_RADIUS,
      cy: ty * GALAXY_RADIUS,
      cz: tz * GALAXY_RADIUS,
      color: meta.color,
      label: meta.label,
      spinSpeed: meta.speed,
      spin: 0,
      systems: {},
      members: [],
      sandSwarm: createSandSwarm(cognitiveType),
    };
    return [cognitiveType, galaxy] as const;
  });
  return Object.fromEntries(entries) as Record<CognitiveType, GalacticGalaxy>;
}

export function updateGalacticPositions(nodes: GalacticNode[], elapsedMs: number): void {
  for (const node of nodes) {
    node.galaxy.spin = node.galaxy.spinSpeed * elapsedMs;
    const theta = node.localAngleSeed + elapsedMs * node.localSpeed + node.galaxy.spin * 0.4;
    const phi = node.localPolarAngle + Math.sin(theta * 0.3) * 0.15;
    const r = node.localOrbitR;
    node.x = node.system.cx + Math.sin(phi) * Math.cos(theta) * r;
    node.y = node.system.cy + Math.sin(phi) * Math.sin(theta) * r;
    node.z = node.system.cz + Math.cos(phi) * r;
    node.localAngle = theta;
  }
}

export function planetRadiusForMass(inboundCount: number, siblingIndex: number): {
  mass: number;
  localOrbitR: number;
  size: number;
} {
  const mass = Math.min(1, Math.max(0, inboundCount) / 16);
  return {
    mass,
    localOrbitR: PLANET_RADIUS * (1.05 - mass * 0.55 + (siblingIndex % 3) * 0.14),
    size: Math.min(16, 3 + Math.log2(1 + Math.max(0, inboundCount)) * 2.4),
  };
}

export function normalizeDomain(node: Pick<GraphNode, "kind" | "type">): DomainType {
  if (node.kind === "crystal" || node.type === "crystal" || node.type === "crystals") return "crystals";
  if (DOMAIN_ORDER.includes(node.type as DomainType)) return node.type as DomainType;
  // Honest fallbacks: a raw capture is its own episodic class, not a curated
  // "lesson"; an unrecognized wiki type is "other", not a "reference". The old
  // mapping silently re-labeled threads/procedures/people as references and raw
  // captures as lessons, changing their epistemic meaning.
  if (node.kind === "raw") return "raw";
  return "other";
}

export function worldToScreen(point: Point, camera: { camX: number; camY: number; scale: number }, size: { width: number; height: number }): Point {
  return {
    x: (point.x - camera.camX) * camera.scale + size.width / 2,
    y: (point.y - camera.camY) * camera.scale + size.height / 2,
  };
}

export function screenToWorld(point: Point, camera: { camX: number; camY: number; scale: number }, size: { width: number; height: number }): Point {
  return {
    x: (point.x - size.width / 2) / camera.scale + camera.camX,
    y: (point.y - size.height / 2) / camera.scale + camera.camY,
  };
}

function ensureSystem(galaxy: GalacticGalaxy, domain: DomainType): GalacticSystem {
  const existing = galaxy.systems[domain];
  if (existing) return existing;
  const domainIndex = DOMAIN_ORDER.indexOf(domain);
  const n = DOMAIN_ORDER.length;
  const phi = Math.acos(1 - 2 * (domainIndex + 0.5) / n);
  const theta = Math.PI * (1 + Math.sqrt(5)) * domainIndex;
  const meta = DOMAIN_META[domain];
  const system: GalacticSystem = {
    id: domain,
    cognitiveType: galaxy.id,
    angle: theta,
    cx: galaxy.cx + Math.sin(phi) * Math.cos(theta) * SYSTEM_RADIUS,
    cy: galaxy.cy + Math.sin(phi) * Math.sin(theta) * SYSTEM_RADIUS,
    cz: galaxy.cz + Math.cos(phi) * SYSTEM_RADIUS,
    color: meta.color,
    label: meta.label,
    members: [],
  };
  galaxy.systems[domain] = system;
  return system;
}

function createSandSwarm(cognitiveType: CognitiveType): SandParticle[] {
  const color = COGNITIVE_META[cognitiveType].color;
  return Array.from({ length: 90 }, (_, index) => ({
    angle: seededUnit(`${cognitiveType}:${index}`, 1) * Math.PI * 2,
    r: 60 + seededUnit(`${cognitiveType}:${index}`, 2) * 280,
    speed: 0.0009 + seededUnit(`${cognitiveType}:${index}`, 3) * 0.0018,
    size: 0.6 + seededUnit(`${cognitiveType}:${index}`, 4),
    hue: seededUnit(`${cognitiveType}:${index}`, 5) < 0.5 ? color : "#ffffff",
  }));
}

function seededUnit(value: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}
