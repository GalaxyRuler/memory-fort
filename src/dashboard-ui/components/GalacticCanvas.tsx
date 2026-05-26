import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CognitiveType, GraphEdge, GraphNode } from "../hooks/useGraph.js";
import {
  buildGalacticLayout,
  COGNITIVE_META,
  DOMAIN_META,
  screenToWorld,
  updateGalacticPositions,
  worldToScreen,
  type GalacticLayout,
  type GalacticNode,
} from "../lib/galactic/layout.js";
import { confidenceGlow, edgeLensing, zoomLevelForScale, clamp } from "../lib/galactic/physics.js";
import { hexA, PLANET_RENDERERS } from "../lib/galactic/planets.js";

export type GalacticZoomLevel = 0 | 1 | 2;

export interface EdgeRenderStyleOptions {
  highlighted: boolean;
  sourceCognitiveType: CognitiveType;
  targetCognitiveType: CognitiveType;
  weight: number;
  zoomLevel: GalacticZoomLevel;
}

export interface GalacticCanvasHandle {
  focusNode: (path: string, scale?: number) => void;
  setZoomLevel: (level: GalacticZoomLevel) => void;
}

export interface GalacticCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId?: string | null;
  zoomLevel?: GalacticZoomLevel;
  onSelectNode?: (id: string | null) => void;
  onHoverNode?: (id: string | null) => void;
  onZoomLevelChange?: (level: GalacticZoomLevel) => void;
}

interface Camera {
  camX: number;
  camY: number;
  scale: number;
}

interface DragState {
  x: number;
  y: number;
  camX: number;
  camY: number;
}

const LEVEL_SCALE: Record<GalacticZoomLevel, number> = {
  0: 0.18,
  1: 0.55,
  2: 1.4,
};

export const GalacticCanvas = forwardRef<GalacticCanvasHandle, GalacticCanvasProps>(function GalacticCanvas(
  { edges, nodes, onHoverNode, onSelectNode, onZoomLevelChange, selectedNodeId = null, zoomLevel },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<GalacticLayout>(buildGalacticLayout([], []));
  const cameraRef = useRef<Camera>({ camX: 0, camY: 0, scale: LEVEL_SCALE[0] });
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selectedNodeId);
  const [tooltip, setTooltip] = useState<{ title: string; x: number; y: number } | null>(null);
  const [cameraVersion, setCameraVersion] = useState(0);

  const layout = useMemo(() => buildGalacticLayout(nodes, edges), [nodes, edges]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    selectedRef.current = selectedNodeId;
  }, [selectedNodeId]);

  const emitZoom = useCallback(() => {
    onZoomLevelChange?.(zoomLevelForScale(cameraRef.current.scale));
  }, [onZoomLevelChange]);

  const focusNode = useCallback((path: string, scale = Math.max(cameraRef.current.scale, 0.9)) => {
    const node = layoutRef.current.nodes.find((item) => item.path === path);
    if (!node) return;
    cameraRef.current = { camX: node.galaxy.cx, camY: node.galaxy.cy, scale };
    setCameraVersion((value) => value + 1);
    emitZoom();
  }, [emitZoom]);

  const setZoomLevel = useCallback((level: GalacticZoomLevel) => {
    const selected = selectedRef.current ? layoutRef.current.nodes.find((node) => node.path === selectedRef.current) : null;
    const fallback = layoutRef.current.galaxies.semantic;
    const target = level === 0 ? { cx: 0, cy: 0 } : selected?.galaxy ?? fallback;
    cameraRef.current = { camX: target.cx, camY: target.cy, scale: LEVEL_SCALE[level] };
    setCameraVersion((value) => value + 1);
    onZoomLevelChange?.(level);
  }, [onZoomLevelChange]);

  useImperativeHandle(ref, () => ({ focusNode, setZoomLevel }), [focusNode, setZoomLevel]);

  useEffect(() => {
    if (zoomLevel === undefined) return;
    setZoomLevel(zoomLevel);
  }, [setZoomLevel, zoomLevel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let width = 1;
    let height = 1;
    let start = performance.now();
    const resize = () => {
      const rect = wrapper.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = Math.max(1, rect.width || 1);
      height = Math.max(1, rect.height || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(wrapper);

    const draw = (now: number) => {
      const elapsed = now - start;
      updateGalacticPositions(layoutRef.current.nodes, elapsed);
      render(ctx, layoutRef.current, cameraRef.current, { width, height }, elapsed, hoverRef.current, selectedRef.current);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame((now) => {
      start = now;
      draw(now);
    });

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [cameraVersion]);

  const hitTest = useCallback((clientX: number, clientY: number): GalacticNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const point = { x: clientX - rect.left, y: clientY - rect.top };
    const size = { width: rect.width, height: rect.height };
    for (let index = layoutRef.current.nodes.length - 1; index >= 0; index -= 1) {
      const node = layoutRef.current.nodes[index]!;
      const screen = worldToScreen({ x: node.x, y: node.y }, cameraRef.current, size);
      const radius = node.size * cameraRef.current.scale * 0.95 + 4;
      if (Math.hypot(screen.x - point.x, screen.y - point.y) < Math.max(8, radius)) return node;
    }
    return null;
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      camX: cameraRef.current.camX,
      camY: cameraRef.current.camY,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      cameraRef.current.camX = drag.camX - (event.clientX - drag.x) / cameraRef.current.scale;
      cameraRef.current.camY = drag.camY - (event.clientY - drag.y) / cameraRef.current.scale;
      return;
    }

    const hit = hitTest(event.clientX, event.clientY);
    if (hoverRef.current !== (hit?.path ?? null)) {
      hoverRef.current = hit?.path ?? null;
      onHoverNode?.(hoverRef.current);
    }
    setTooltip(hit ? { title: hit.title, x: event.clientX + 14, y: event.clientY + 14 } : null);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 4) return;
    const hit = hitTest(event.clientX, event.clientY);
    selectedRef.current = hit?.path ?? null;
    onSelectNode?.(hit?.path ?? null);
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const size = { width: rect.width, height: rect.height };
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const before = screenToWorld(point, cameraRef.current, size);
    cameraRef.current.scale = clamp(cameraRef.current.scale * Math.exp(-event.deltaY * 0.001), 0.08, 3.2);
    const after = screenToWorld(point, cameraRef.current, size);
    cameraRef.current.camX += before.x - after.x;
    cameraRef.current.camY += before.y - after.y;
    emitZoom();
  };

  return (
    <div ref={wrapperRef} className="absolute inset-0 overflow-hidden bg-background" data-testid="galactic-canvas-shell">
      <canvas
        ref={canvasRef}
        aria-label="Galactic memory graph"
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        data-testid="galactic-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      />
      {tooltip && (
        <div
          className="pointer-events-none fixed z-40 rounded border border-border-emphasis bg-surface/90 px-2 py-1 font-mono text-[11px] text-text-primary shadow-lg"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.title}
        </div>
      )}
    </div>
  );
});

function render(
  ctx: CanvasRenderingContext2D,
  layout: GalacticLayout,
  camera: Camera,
  size: { width: number; height: number },
  elapsed: number,
  hoverId: string | null,
  selectedId: string | null,
): void {
  const bg = ctx.createRadialGradient(size.width / 2, size.height / 2, 0, size.width / 2, size.height / 2, Math.max(size.width, size.height));
  bg.addColorStop(0, "#080614");
  bg.addColorStop(1, "#010003");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size.width, size.height);
  drawStarfield(ctx, size, elapsed);

  for (const galaxy of Object.values(layout.galaxies)) drawAccretionSwarm(ctx, galaxy, camera, size, elapsed);
  for (const edge of layout.edges) drawEdge(ctx, edge, camera, size, elapsed, selectedId);
  if (camera.scale > 0.3) {
    for (const galaxy of Object.values(layout.galaxies)) {
      for (const system of Object.values(galaxy.systems)) if (system) drawSystemBackdrop(ctx, system, camera, size);
    }
  }
  for (const galaxy of Object.values(layout.galaxies)) drawGalaxyCore(ctx, galaxy, camera, size);
  for (const node of layout.nodes) drawPlanet(ctx, node, camera, size, hoverId, selectedId);
  if (camera.scale > 0.6 && camera.scale < 1.6) {
    for (const galaxy of Object.values(layout.galaxies)) {
      for (const system of Object.values(galaxy.systems)) if (system) drawSystemLabel(ctx, system, camera, size);
    }
  }
  for (const galaxy of Object.values(layout.galaxies)) drawGalaxyLabel(ctx, galaxy, camera, size);
}

function drawStarfield(ctx: CanvasRenderingContext2D, size: { width: number; height: number }, elapsed: number): void {
  for (let index = 0; index < 220; index += 1) {
    const x = ((index * 97) % 1000) / 1000;
    const y = ((index * 53) % 1000) / 1000;
    const twinkle = 0.4 + 0.6 * Math.sin(elapsed * 0.001 + x * 30 + y * 30);
    ctx.fillStyle = `rgba(255,255,255,${(0.15 + ((index * 17) % 70) / 100) * 0.5 * twinkle})`;
    ctx.fillRect(x * size.width, y * size.height, 1, 1);
  }
}

function drawAccretionSwarm(ctx: CanvasRenderingContext2D, galaxy: GalacticLayout["galaxies"][keyof GalacticLayout["galaxies"]], camera: Camera, size: { width: number; height: number }, elapsed: number): void {
  if (camera.scale > 0.9) return;
  const center = worldToScreen({ x: galaxy.cx, y: galaxy.cy }, camera, size);
  for (const sand of galaxy.sandSwarm) {
    const angle = sand.angle + sand.speed * elapsed * 0.5;
    ctx.fillStyle = hexA(sand.hue, 0.55);
    const sandSize = Math.max(0.6, sand.size * Math.min(1, camera.scale * 1.4));
    ctx.fillRect(center.x + Math.cos(angle) * sand.r * camera.scale, center.y + Math.sin(angle) * sand.r * camera.scale, sandSize, sandSize);
  }
}

function drawGalaxyCore(ctx: CanvasRenderingContext2D, galaxy: GalacticLayout["galaxies"][keyof GalacticLayout["galaxies"]], camera: Camera, size: { width: number; height: number }): void {
  const point = worldToScreen({ x: galaxy.cx, y: galaxy.cy }, camera, size);
  const radius = 28 * camera.scale + 8;
  const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 4);
  gradient.addColorStop(0, hexA(galaxy.color, 0.9));
  gradient.addColorStop(0.3, hexA(galaxy.color, 0.35));
  gradient.addColorStop(1, hexA(galaxy.color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius * 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(point.x, point.y, Math.max(2, radius * 0.25), 0, Math.PI * 2);
  ctx.fill();
}

function drawGalaxyLabel(ctx: CanvasRenderingContext2D, galaxy: GalacticLayout["galaxies"][keyof GalacticLayout["galaxies"]], camera: Camera, size: { width: number; height: number }): void {
  if (camera.scale > 0.45) return;
  const point = worldToScreen({ x: galaxy.cx, y: galaxy.cy }, camera, size);
  ctx.save();
  ctx.font = `700 ${Math.max(10, 14 * camera.scale)}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = hexA(galaxy.color, 0.85);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(COGNITIVE_META[galaxy.id].label.toUpperCase(), point.x, point.y + 36 * camera.scale + 12);
  ctx.font = `400 ${Math.max(8, 10 * camera.scale)}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = "rgba(155, 164, 184, 0.7)";
  ctx.fillText(`${galaxy.members.length} memories`, point.x, point.y + 36 * camera.scale + 28);
  ctx.restore();
}

function drawSystemBackdrop(ctx: CanvasRenderingContext2D, system: NonNullable<GalacticLayout["galaxies"][keyof GalacticLayout["galaxies"]]["systems"][keyof GalacticLayout["galaxies"][keyof GalacticLayout["galaxies"]]["systems"]]>, camera: Camera, size: { width: number; height: number }): void {
  const point = worldToScreen({ x: system.cx, y: system.cy }, camera, size);
  const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, 160 * camera.scale);
  gradient.addColorStop(0, hexA(system.color, 0.16));
  gradient.addColorStop(1, hexA(system.color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 160 * camera.scale, 0, Math.PI * 2);
  ctx.fill();
}

function drawSystemLabel(ctx: CanvasRenderingContext2D, system: NonNullable<GalacticLayout["galaxies"][keyof GalacticLayout["galaxies"]]["systems"][keyof GalacticLayout["galaxies"][keyof GalacticLayout["galaxies"]]["systems"]]>, camera: Camera, size: { width: number; height: number }): void {
  const point = worldToScreen({ x: system.cx, y: system.cy }, camera, size);
  ctx.save();
  ctx.font = `600 ${Math.max(9, 11 * camera.scale)}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = hexA(system.color, 0.78);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(DOMAIN_META[system.id].label.toUpperCase(), point.x, point.y);
  ctx.restore();
}

function drawEdge(ctx: CanvasRenderingContext2D, edge: GalacticLayout["edges"][number], camera: Camera, size: { width: number; height: number }, elapsed: number, selectedId: string | null): void {
  const lens = edgeLensing(edge.source, edge.target, edge.source.galaxy, edge.weight);
  const source = worldToScreen(edge.source, camera, size);
  const target = worldToScreen(edge.target, camera, size);
  const control = worldToScreen({ x: lens.controlX, y: lens.controlY }, camera, size);
  const highlighted = selectedId === edge.source.path || selectedId === edge.target.path;
  const style = computeEdgeRenderStyle({
    highlighted,
    sourceCognitiveType: edge.source.cognitiveType,
    targetCognitiveType: edge.target.cognitiveType,
    weight: edge.weight,
    zoomLevel: zoomLevelForScale(camera.scale),
  });
  const gradient = ctx.createLinearGradient(source.x, source.y, target.x, target.y);
  gradient.addColorStop(0, hexA(DOMAIN_META[edge.source.domain].color, style.opacity));
  gradient.addColorStop(1, hexA(DOMAIN_META[edge.target.domain].color, style.opacity));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = style.lineWidth;
  ctx.strokeStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(source.x, source.y);
  ctx.quadraticCurveTo(control.x, control.y, target.x, target.y);
  ctx.stroke();
  if (camera.scale > 0.4) {
    const flowRate = 0.00018 + edge.weight * 0.00035;
    const tFlow = (elapsed * flowRate) % 1;
    const count = highlighted ? 3 : Math.max(1, Math.round(edge.weight * 2.2));
    for (let index = 0; index < count; index += 1) {
      const t = (tFlow + index / count) % 1;
      ctx.fillStyle = highlighted ? "#fff" : hexA(DOMAIN_META[edge.source.domain].color, 0.9);
      ctx.beginPath();
      ctx.arc(quad(source.x, control.x, target.x, t), quad(source.y, control.y, target.y, t), highlighted ? 1.6 : 1 + edge.weight * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export function computeEdgeRenderStyle({
  highlighted,
  sourceCognitiveType,
  targetCognitiveType,
  weight,
  zoomLevel,
}: EdgeRenderStyleOptions): { lineWidth: number; opacity: number } {
  const crossGalaxy = sourceCognitiveType !== targetCognitiveType;
  const boost = crossGalaxy ? 1.5 : 1;
  const baseLineWidth = highlighted ? 1.4 + weight * 0.6 : 0.4 + weight * 0.6;
  const baseOpacity = (highlighted ? 0.55 : 0.2) + weight * 0.35;
  const lineWidth = zoomLevel === 0 ? Math.max(0.8, baseLineWidth) : baseLineWidth;
  const opacity = zoomLevel === 0 ? Math.max(0.35, baseOpacity) : baseOpacity;
  return {
    lineWidth: lineWidth * boost,
    opacity: opacity * boost,
  };
}

function drawPlanet(ctx: CanvasRenderingContext2D, node: GalacticNode, camera: Camera, size: { width: number; height: number }, hoverId: string | null, selectedId: string | null): void {
  const point = worldToScreen(node, camera, size);
  const radius = node.size * camera.scale * 0.95;
  if (point.x < -50 || point.x > size.width + 50 || point.y < -50 || point.y > size.height + 50) return;
  const glow = confidenceGlow(node.confidence, radius);
  const gradient = ctx.createRadialGradient(point.x, point.y, radius * 0.5, point.x, point.y, glow.radius);
  gradient.addColorStop(0, hexA(DOMAIN_META[node.domain].color, glow.opacity));
  gradient.addColorStop(1, hexA(DOMAIN_META[node.domain].color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(point.x, point.y, glow.radius, 0, Math.PI * 2);
  ctx.fill();

  PLANET_RENDERERS[node.domain](ctx, point.x, point.y, Math.max(2, radius), node);
  if (hoverId === node.path || selectedId === node.path) {
    ctx.strokeStyle = selectedId === node.path ? "#fff" : hexA(DOMAIN_META[node.domain].color, 0.7);
    ctx.lineWidth = selectedId === node.path ? 2 : 1.2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (camera.scale > 1.1 && radius > 4) {
    ctx.font = `500 ${Math.min(12, 9 + radius * 0.4)}px Inter, sans-serif`;
    ctx.fillStyle = "rgba(232, 236, 244, 0.85)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(node.title, point.x, point.y + radius + 6);
  }
}

function quad(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}
