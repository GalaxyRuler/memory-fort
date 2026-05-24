import { useEffect, useMemo, useRef } from "react";
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-3d";
import * as THREE from "three";
import { type GraphEdge, type GraphNode } from "../hooks/useGraph.js";
import { edgeColor, nodeColor } from "../lib/graph-colors.js";
import { getEdgeOpacity, getForceSimulationConfig, getNodeSize, type GraphMode } from "../lib/graph-layouts.js";

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode: GraphMode;
  enabledTypes: Set<string>;
  onNodeClick: (node: GraphNode) => void;
  width?: number;
  height?: number;
}

interface GraphCanvasNode extends GraphNode {
  id: string;
  __color: string;
  __size: number;
}

interface GraphCanvasLink {
  source: string;
  target: string;
  __color: string;
  __kind: GraphEdge["kind"];
  __relationType: string | null;
}

interface LinkForce {
  distance: (distance: number) => LinkForce;
  strength: (strength: number) => LinkForce;
}

interface StrengthForce {
  strength: (strength: number) => StrengthForce;
}

export function GraphCanvas({ nodes, edges, mode, enabledTypes, onNodeClick, width, height }: GraphCanvasProps) {
  const fgRef = useRef<ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined>(undefined);

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
    return {
      nodes: filteredNodes.map(
        (node): GraphCanvasNode => ({
          ...node,
          id: node.path,
          __color: nodeColor(node),
          __size: getNodeSize(node.inboundCount, mode),
        }),
      ),
      links: filteredEdges.map(
        (edge): GraphCanvasLink => ({
          source: edge.fromPath,
          target: edge.toPath,
          __color: edgeColor(edge),
          __kind: edge.kind,
          __relationType: edge.relationType,
        }),
      ),
    };
  }, [filteredNodes, filteredEdges, mode]);

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
      const size = node.__size;
      const color = node.__color;
      const geometry = new THREE.SphereGeometry(size, 16, 16);
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
      });
      const sphere = new THREE.Mesh(geometry, material);

      const haloGeometry = new THREE.SphereGeometry(size * 1.8, 16, 16);
      const haloMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.15,
      });
      sphere.add(new THREE.Mesh(haloGeometry, haloMaterial));

      return sphere;
    };
  }, []);

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
      linkOpacity={getEdgeOpacity(mode)}
      linkDirectionalParticles={mode === "force" ? 2 : 0}
      linkDirectionalParticleSpeed={0.005}
      linkDirectionalParticleWidth={1.5}
      backgroundColor="#050508"
      showNavInfo={false}
      onNodeClick={(node: NodeObject<GraphCanvasNode>) => onNodeClick(node)}
      enableNavigationControls={true}
      enableNodeDrag={false}
    />
  );
}
