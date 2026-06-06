import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export interface WikiIndexEntry {
  category: string;
  slug: string;
  relPath: string;
  title: string;
  summary: string;
  updated: string;
}

export interface WikiIndex {
  byCategory: Record<string, WikiIndexEntry[]>;
  total: number;
}

export function useWikiIndex() {
  return useQuery({
    queryKey: ["wiki-index"],
    queryFn: () => apiGet<WikiIndex>("/wiki"),
    staleTime: 60_000,
  });
}
