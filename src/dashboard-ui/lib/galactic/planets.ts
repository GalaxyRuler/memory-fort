import type { DomainType } from "./layout.js";

export interface PlanetRenderNode {
  domain: DomainType;
  confidence: number | null;
  localAngle: number;
}

export type PlanetRenderer = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  node: PlanetRenderNode,
) => void;

export const PLANET_RENDERERS: Record<DomainType, PlanetRenderer> = {
  decisions: drawDecisionPlanet,
  issues: drawDecisionPlanet,
  lessons: drawLessonPlanet,
  projects: drawProjectPlanet,
  references: drawReferencePlanet,
  tools: drawToolPlanet,
  crystals: drawCrystalPlanet,
};

export function drawGenericPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.fillStyle = "#60a5fa";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

export function drawDecisionPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, node: PlanetRenderNode): void {
  ctx.save();
  const atmosphere = ctx.createRadialGradient(x, y, radius * 0.7, x, y, radius * 1.6);
  atmosphere.addColorStop(0, hexA("#f472b6", 0.35));
  atmosphere.addColorStop(1, hexA("#f472b6", 0));
  ctx.fillStyle = atmosphere;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  const bands = ["#7f1d5a", "#be3b83", "#f472b6", "#9d2d6d", "#f9a8d4"];
  for (let index = 0; index < bands.length; index += 1) {
    ctx.fillStyle = bands[index]!;
    ctx.fillRect(x - radius, y - radius + (index * 2 * radius) / bands.length, radius * 2, (2 * radius) / bands.length + 1);
  }
  if ((node.confidence ?? 1) < 0.75) {
    ctx.fillStyle = "rgba(255, 215, 0, 0.6)";
    ctx.beginPath();
    ctx.ellipse(x - radius * 0.2, y, radius * 0.32, radius * 0.18, 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

export function drawLessonPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, node: PlanetRenderNode): void {
  ctx.save();
  const halo = ctx.createRadialGradient(x, y, radius * 0.6, x, y, radius * 2.2);
  halo.addColorStop(0, hexA("#a78bfa", 0.4));
  halo.addColorStop(1, hexA("#a78bfa", 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
  ctx.fill();

  const gradient = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.3, 0, x, y, radius);
  gradient.addColorStop(0, "#ddd6fe");
  gradient.addColorStop(1, "#7c3aed");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  const moonAngle = node.localAngle * 4;
  const moonDistance = radius * 1.7;
  const moonX = x + Math.cos(moonAngle) * moonDistance;
  const moonY = y + Math.sin(moonAngle) * moonDistance;
  ctx.fillStyle = "#c4b5fd";
  ctx.beginPath();
  ctx.arc(moonX, moonY, radius * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(167, 139, 250, 0.25)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.arc(x, y, moonDistance, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawProjectPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, node: PlanetRenderNode): void {
  ctx.save();
  const corona = ctx.createRadialGradient(x, y, 0, x, y, radius * 2.6);
  corona.addColorStop(0, "rgba(220, 252, 231, 0.9)");
  corona.addColorStop(0.4, "rgba(74, 222, 128, 0.4)");
  corona.addColorStop(1, "rgba(74, 222, 128, 0)");
  ctx.fillStyle = corona;
  ctx.beginPath();
  ctx.arc(x, y, radius * 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#dcfce7";
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4ade80";
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.55, 0, Math.PI * 2);
  ctx.fill();
  for (let index = 0; index < 3; index += 1) {
    const angle = node.localAngle * 2 + index * (Math.PI * 2 / 3);
    ctx.fillStyle = "#bbf7d0";
    ctx.beginPath();
    ctx.arc(x + Math.cos(angle) * radius * 1.8, y + Math.sin(angle) * radius * 1.8, radius * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(74, 222, 128, 0.3)";
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawReferencePlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, _node: PlanetRenderNode): void {
  ctx.save();
  const atmosphere = ctx.createRadialGradient(x, y, radius * 0.85, x, y, radius * 1.5);
  atmosphere.addColorStop(0, hexA("#60a5fa", 0.4));
  atmosphere.addColorStop(1, hexA("#60a5fa", 0));
  ctx.fillStyle = atmosphere;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  ["#1d4ed8", "#2563eb", "#60a5fa", "#93c5fd", "#3b82f6"].forEach((color, index, bands) => {
    ctx.fillStyle = color;
    ctx.fillRect(x - radius, y - radius + (index * 2 * radius) / bands.length, radius * 2, (2 * radius) / bands.length + 1);
  });
  ctx.restore();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.4);
  ctx.strokeStyle = "rgba(147, 197, 253, 0.55)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 1.7, radius * 0.35, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(147, 197, 253, 0.3)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 1.95, radius * 0.42, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawToolPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, node: PlanetRenderNode): void {
  drawPolygonPlanet(ctx, x, y, radius, node.localAngle * 0.5, 8, ["#713f12", "#fbbf24", "#92400e"], "rgba(251, 191, 36, 0.5)");
}

export function drawCrystalPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, node: PlanetRenderNode): void {
  ctx.save();
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 2.2);
  glow.addColorStop(0, hexA("#22d3ee", 0.6));
  glow.addColorStop(0.5, hexA("#22d3ee", 0.18));
  glow.addColorStop(1, hexA("#22d3ee", 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  drawPolygonPlanet(ctx, x, y, radius, node.localAngle * 0.3 - Math.PI / 2, 6, ["#0e7490", "#22d3ee", "#a5f3fc"], "rgba(255,255,255,0.6)", true);
}

export function hexA(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

function drawPolygonPlanet(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  rotation: number,
  sides: number,
  colors: [string, string, string],
  stroke: string,
  facets = false,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.beginPath();
  for (let index = 0; index < sides; index += 1) {
    const angle = (index / sides) * Math.PI * 2;
    const px = Math.cos(angle) * radius;
    const py = Math.sin(angle) * radius;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  const gradient = ctx.createLinearGradient(-radius, -radius, radius, radius);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.5, colors[1]);
  gradient.addColorStop(1, colors[2]);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = facets ? 0.8 : 0.6;
  ctx.stroke();
  if (facets) {
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 0.5;
    for (let index = 0; index < sides; index += 1) {
      const angle = (index / sides) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let index = 0; index < sides; index += 1) {
      const angle = (index / sides) * Math.PI * 2 + Math.PI / sides;
      const px = Math.cos(angle) * radius * 1.5;
      const py = Math.sin(angle) * radius * 1.5;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}
