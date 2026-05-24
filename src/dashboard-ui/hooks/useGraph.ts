import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export type GraphScope = "wiki" | "raw" | "crystals" | "all";

export interface GraphNode {
  path: string;
  title: string;
  kind: "wiki" | "raw" | "crystal";
  type: string;
  confidence: number | null;
  updated: string | null;
  inboundCount: number;
  outboundCount: number;
}

export interface GraphEdge {
  fromPath: string;
  toPath: string;
  kind: "relation" | "wikilink";
  relationType: string | null;
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
  });
}
