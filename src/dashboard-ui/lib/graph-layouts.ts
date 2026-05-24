export type GraphMode = "force" | "clustered" | "constellation" | "orbital" | "timeline-flow";

export interface ForceConfig {
  linkDistance: number;
  linkStrength: number;
  chargeStrength: number;
  centerStrength: number;
  collideRadius: number;
}

export function getForceSimulationConfig(mode: GraphMode): ForceConfig {
  switch (mode) {
    case "force":
      return { linkDistance: 60, linkStrength: 0.8, chargeStrength: -200, centerStrength: 0.05, collideRadius: 8 };
    case "clustered":
      return { linkDistance: 90, linkStrength: 0.3, chargeStrength: -400, centerStrength: 0.02, collideRadius: 12 };
    case "constellation":
      return { linkDistance: 120, linkStrength: 0.15, chargeStrength: -60, centerStrength: 0.1, collideRadius: 4 };
    case "orbital":
      return { linkDistance: 80, linkStrength: 0.05, chargeStrength: -50, centerStrength: 0.01, collideRadius: 6 };
    case "timeline-flow":
      return { linkDistance: 80, linkStrength: 0.2, chargeStrength: -150, centerStrength: 0.03, collideRadius: 6 };
  }
}

export function usesFixedPositions(mode: GraphMode): boolean {
  return mode === "orbital" || mode === "timeline-flow";
}

export function getNodeSize(inboundCount: number, mode: GraphMode): number {
  const base = Math.max(2, Math.log2(inboundCount + 1) * 3);
  if (mode === "constellation") return Math.max(1.5, base * 0.5);
  return base;
}

export function getEdgeOpacity(mode: GraphMode): number {
  switch (mode) {
    case "force":
      return 0.6;
    case "clustered":
      return 0.35;
    case "constellation":
      return 0.2;
    case "orbital":
      return 0.45;
    case "timeline-flow":
      return 0.3;
  }
}
