import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";
import type { ConfidenceVector, LifecycleStage } from "../../storage/frontmatter.js";

export type GraphScope = "wiki" | "raw" | "crystals" | "all";
export type CognitiveType = "core" | "semantic" | "episodic" | "procedural";

export interface GraphNode {
  path: string;
  title: string;
  kind: "wiki" | "raw" | "crystal";
  type: string;
  cognitiveType: CognitiveType;
  status: string;
  source: string;
  created: string | null;
  confidence: number | null;
  confidenceFull?: number | ConfidenceVector | null;
  importance?: number | null;
  lifecycle?: LifecycleStage | null;
  tags: string[];
  description: string;
  updated: string | null;
  inboundCount: number;
  outboundCount: number;
}

export interface GraphEdge {
  fromPath: string;
  toPath: string;
  kind: "relation" | "wikilink";
  relationType: string | null;
  type: string;
  validFrom?: string;
  validTo?: string | null;
  supersededBy?: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedTargets: Array<{ fromPath: string; raw: string; reason: string }>;
}

export function useGraph(scope: GraphScope = "wiki") {
  return useQuery({
    queryKey: ["graph", scope],
    queryFn: () => apiGet<GraphResponse>("/graph", { scope }),
    staleTime: 60_000,
    // Keep the previous scope's graph on screen while the new one loads so
    // switching scope doesn't flash a full-screen "Loading graph..." and tear
    // down the WebGL canvas.
    placeholderData: keepPreviousData,
  });
}
