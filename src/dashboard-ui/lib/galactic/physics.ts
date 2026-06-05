export interface Point {
  x: number;
  y: number;
}

export function massPull(system: Point, galaxy: Point, mass: number): Point & { pull: number } {
  const pull = clamp(mass, 0, 1) * 0.5;
  return {
    x: system.x * (1 - pull) + galaxy.x * pull,
    y: system.y * (1 - pull) + galaxy.y * pull,
    pull,
  };
}

export function edgeLensing(
  source: Point,
  target: Point,
  galaxy: Point,
  weight: number,
): { controlX: number; controlY: number; warp: number } {
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  const dx = galaxy.x - midX;
  const dy = galaxy.y - midY;
  const dist = Math.hypot(dx, dy) || 1;
  const warp = (160 + weight * 180) / (dist / 100 + 1);
  return {
    controlX: midX + (dx / dist) * warp,
    controlY: midY + (dy / dist) * warp,
    warp,
  };
}

export function confidenceGlow(confidence: number | null, radius: number): { radius: number; opacity: number } {
  const conf = clamp(confidence ?? 0.55, 0, 1);
  return {
    radius: Math.max(3, radius * 1.6 * (0.5 + conf * 0.5)),
    opacity: 0.08 + Math.pow(conf, 1.6) * 0.4,
  };
}

export function edgeWeight(sourceInbound: number, targetInbound: number): number {
  return 0.4 + Math.min(sourceInbound, targetInbound) / 14;
}

export function zoomLevelForScale(scale: number): 0 | 1 | 2 {
  if (scale <= 0.28) return 0;
  if (scale <= 0.85) return 1;
  return 2;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
