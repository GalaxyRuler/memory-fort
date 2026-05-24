import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export interface PageRelation {
  key: string;
  target: string;
  resolvedPath: string | null;
  resolvedTitle: string | null;
}

export interface PageInbound {
  fromPath: string;
  fromTitle: string | null;
  via: string;
}

export interface PageDetail {
  relPath: string;
  fullPath: string;
  frontmatter: {
    type?: string;
    title?: string;
    created?: string;
    updated?: string;
    status?: string;
    confidence?: number;
    source?: string;
    session?: string;
    tags?: string[];
    relations?: Record<string, string[]>;
    [key: string]: unknown;
  };
  body: string;
  relations: PageRelation[];
  inbound: PageInbound[];
}

export function usePageDetail(relPath: string) {
  return useQuery({
    queryKey: ["page", relPath],
    queryFn: () => apiGet<PageDetail>(`/page/${encodeURIComponent(relPath)}`),
    enabled: relPath.length > 0,
    staleTime: 30_000,
  });
}
