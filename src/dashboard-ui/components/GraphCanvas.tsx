import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-3d";
import * as THREE from "three";
import { type GraphEdge, type GraphNode } from "../hooks/useGraph.js";
import { edgeColor, nodeColor } from "../lib/graph-colors.js";
import { getEdgeOpacity, getForceSimulationConfig, getNodeSize, type GraphMode } from "../lib/graph-layouts.js";
import { type PositionedNode } from "../lib/graph-positioning.js";

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode: GraphMode;
  enabledTypes: Set<string>;
  onNodeClick: (node: GraphNode) => void;
  onNodeRightClick?: (node: GraphNode, event: MouseEvent) => void;
  width?: number;
  height?: number;
  fixedPositions?: PositionedNode[];
  visiblePaths?: Set<string>;
  matchedPaths?: Set<string>;
  tracePathSet?: { nodes: Set<string>; edges: Set<string> } | null;
}

interface GraphCanvasNode extends GraphNode {
  id: string;
  __color: string;
  __size: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

interface GraphCanvasLink {
  source: string;
  target: string;
  __color: string;
  __kind: GraphEdge["kind"];
  __relationType: string | null;
  __edgeKey: string;
}

interface LinkForce {
  distance: (distance: number) => LinkForce;
  strength: (strength: number) => LinkForce;
}

interface StrengthForce {
  strength: (strength: number) => StrengthForce;
}

export function GraphCanvas({
  nodes,
  edges,
  mode,
  enabledTypes,
  onNodeClick,
  onNodeRightClick,
  width,
  height,
  fixedPositions,
  visiblePaths,
  matchedPaths,
  tracePathSet,
}: GraphCanvasProps) {
  const fgRef = useRef<ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined>(undefined);
  const [haloPulse, setHaloPulse] = useState(1);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const hasMatchedPaths = (matchedPaths?.size ?? 0) > 0;
  const hasTracePath = tracePathSet !== null && tracePathSet !== undefined && tracePathSet.nodes.size > 0;

  const positionLookup = useMemo(() => {
    const lookup = new Map<string, PositionedNode>();
    for (const position of fixedPositions ?? []) lookup.set(position.path, position);
    return lookup;
  }, [fixedPositions]);

  const filteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      const type = node.type || node.kind;
      return enabledTypes.has(type) || enabledTypes.has(node.kind);
    });
  }, [nodes, enabledTypes]);

  const nodePathSet = useMemo(() => new Set(filteredNodes.map((node) => node.path)), [filteredNodes]);

  const filteredEdges = useMemo(() => {
    return edges.filter((edge) => nodePathSet.has(edge.fromPath) && nodePathSet.has(edge.toPath));
  }, [edges, nodePathSet]);

  const graphData = useMemo(() => {
    const allNodes = filteredNodes.map((node): GraphCanvasNode => {
      const position = positionLookup.get(node.path);
      return {
        ...node,
        id: node.path,
        __color: nodeColor(node),
        __size: getNodeSize(node.inboundCount, mode),
        fx: position?.fx,
        fy: position?.fy,
        fz: position?.fz,
      };
    });
    const allLinks = filteredEdges.map(
      (edge): GraphCanvasLink => ({
        source: edge.fromPath,
        target: edge.toPath,
        __color: edgeColor(edge),
        __kind: edge.kind,
        __relationType: edge.relationType,
        __edgeKey: graphEdgeKey(edge.fromPath, edge.toPath),
      }),
    );
    const visibleNodes = visiblePaths ? allNodes.filter((node) => visiblePaths.has(node.path)) : allNodes;
    const visibleNodePaths = new Set(visibleNodes.map((node) => node.id));
    const visibleLinks = allLinks.filter((link) => visibleNodePaths.has(link.source) && visibleNodePaths.has(link.target));

    return {
      nodes: visibleNodes,
      links: visibleLinks,
    };
  }, [filteredNodes, filteredEdges, mode, positionLookup, visiblePaths]);

  useEffect(() => {
    fgRef.current?.d3ReheatSimulation();
  }, [graphData]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    if (!hasMatchedPaths || prefersReducedMotion) {
      setHaloPulse(1);
      return;
    }

    let frameId = 0;
    const tick = () => {
      setHaloPulse(0.7 + 0.3 * Math.sin(performance.now() * 0.003));
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [hasMatchedPaths, prefersReducedMotion]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const config = getForceSimulationConfig(mode);
    const linkForce = fg.d3Force("link") as unknown as LinkForce | undefined;
    const chargeForce = fg.d3Force("charge") as unknown as StrengthForce | undefined;
    const centerForce = fg.d3Force("center") as unknown as StrengthForce | undefined;

    linkForce?.distance(config.linkDistance).strength(config.linkStrength);
    chargeForce?.strength(config.chargeStrength);
    centerForce?.strength(config.centerStrength);
    fg.d3ReheatSimulation();
  }, [mode]);

  const nodeThreeObject = useMemo(() => {
    return (node: NodeObject<GraphCanvasNode>) => {
      const style = getNodeRenderStyle(node.path, matchedPaths, tracePathSet, haloPulse);
      const size = node.__size;
      const color = node.__color;
      const geometry = new THREE.SphereGeometry(size, 16, 16);
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: style.sphereOpacity,
      });
      const sphere = new THREE.Mesh(geometry, material);

      const haloGeometry = new THREE.SphereGeometry(size * style.haloScale, 16, 16);
      const haloMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: style.haloOpacity,
      });
      sphere.add(new THREE.Mesh(haloGeometry, haloMaterial));

      return sphere;
    };
  }, [haloPulse, matchedPaths, tracePathSet]);

  const linkMaterial = useMemo(() => {
    const materials = new Map<string, THREE.LineBasicMaterial>();
    return (link: LinkObject<GraphCanvasNode, GraphCanvasLink>) => {
      const opacity = getLinkRenderOpacity(link, mode, matchedPaths, tracePathSet);
      const key = `${link.__color}|${opacity}`;
      const existing = materials.get(key);
      if (existing) return existing;

      const material = new THREE.LineBasicMaterial({
        color: link.__color,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      materials.set(key, material);
      return material;
    };
  }, [matchedPaths, mode, tracePathSet]);

  return (
    <ForceGraph3D<GraphCanvasNode, GraphCanvasLink>
      ref={fgRef}
      width={width}
      height={height}
      graphData={graphData}
      nodeId="id"
      nodeColor="__color"
      nodeVal="__size"
      nodeLabel="title"
      nodeThreeObject={nodeThreeObject}
      nodeThreeObjectExtend={false}
      linkColor={(link: LinkObject<GraphCanvasNode, GraphCanvasLink>) => link.__color}
      linkWidth={(link: LinkObject<GraphCanvasNode, GraphCanvasLink>) => (link.__kind === "wikilink" ? 0.5 : 1.2)}
      linkOpacity={1}
      linkMaterial={linkMaterial}
      linkDirectionalParticles={(link: LinkObject<GraphCanvasNode, GraphCanvasLink>) =>
        hasTracePath ? (isTraceLink(link, tracePathSet) ? 4 : 0) : mode === "force" ? 2 : 0
      }
      linkDirectionalParticleSpeed={(link: LinkObject<GraphCanvasNode, GraphCanvasLink>) =>
        hasTracePath && isTraceLink(link, tracePathSet) ? 0.015 : 0.005
      }
      linkDirectionalParticleWidth={1.5}
      linkDirectionalParticleColor={(link: LinkObject<GraphCanvasNode, GraphCanvasLink>) => link.__color}
      backgroundColor="#050508"
      showNavInfo={false}
      onNodeClick={(node: NodeObject<GraphCanvasNode>) => onNodeClick(node)}
      onNodeRightClick={(node: NodeObject<GraphCanvasNode>, event: MouseEvent) => onNodeRightClick?.(node, event)}
      enableNavigationControls={true}
      enableNodeDrag={false}
    />
  );
}

function getNodeRenderStyle(
  path: string,
  matchedPaths: Set<string> | undefined,
  tracePathSet: { nodes: Set<string>; edges: Set<string> } | null | undefined,
  haloPulse: number,
): { sphereOpacity: number; haloOpacity: number; haloScale: number } {
  const hasMatches = (matchedPaths?.size ?? 0) > 0;
  const hasTrace = tracePathSet !== null && tracePathSet !== undefined;
  const isTraceNode = tracePathSet?.nodes.has(path) ?? false;
  const isMatchedNode = matchedPaths?.has(path) ?? false;

  if (hasTrace) {
    if (isTraceNode) return { sphereOpacity: 0.9, haloOpacity: 0.35, haloScale: 2.2 };
    if (hasMatches && isMatchedNode) return { sphereOpacity: 0.9, haloOpacity: 0.35 * haloPulse, haloScale: 2.2 };
    return { sphereOpacity: 0.1, haloOpacity: 0.05, haloScale: 1.8 };
  }

  if (hasMatches) {
    if (isMatchedNode) return { sphereOpacity: 0.9, haloOpacity: 0.35 * haloPulse, haloScale: 2.2 };
    return { sphereOpacity: 0.15, haloOpacity: 0.05, haloScale: 1.8 };
  }

  return { sphereOpacity: 0.9, haloOpacity: 0.15, haloScale: 1.8 };
}

function getLinkRenderOpacity(
  link: LinkObject<GraphCanvasNode, GraphCanvasLink>,
  mode: GraphMode,
  matchedPaths: Set<string> | undefined,
  tracePathSet: { nodes: Set<string>; edges: Set<string> } | null | undefined,
): number {
  if (tracePathSet) return isTraceLink(link, tracePathSet) ? 1 : 0.05;

  if ((matchedPaths?.size ?? 0) > 0) {
    return matchedPaths?.has(linkEndpointPath(link.source)) && matchedPaths.has(linkEndpointPath(link.target)) ? getEdgeOpacity(mode) : 0.05;
  }

  return getEdgeOpacity(mode);
}

function isTraceLink(
  link: LinkObject<GraphCanvasNode, GraphCanvasLink>,
  tracePathSet: { nodes: Set<string>; edges: Set<string> } | null | undefined,
): boolean {
  return tracePathSet?.edges.has(link.__edgeKey) ?? false;
}

function linkEndpointPath(endpoint: string | number | NodeObject<GraphCanvasNode> | undefined): string {
  return typeof endpoint === "object" ? String(endpoint.id ?? "") : String(endpoint ?? "");
}

function graphEdgeKey(fromPath: string, toPath: string): string {
  return `${fromPath}\u0000${toPath}`;
}
