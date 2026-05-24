export type GraphMode = "force" | "clustered" | "constellation";

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
  }
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
  }
}
