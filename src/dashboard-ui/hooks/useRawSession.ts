import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";
import type { RawSource } from "../lib/raw-helpers.js";

export interface RawSessionDetail {
  date: string;
  filename: string;
  fullPath: string;
  source: RawSource;
  sessionId: string;
  sizeBytes: number;
  mtime: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export function useRawSession(date: string, filename: string) {
  return useQuery({
    queryKey: ["raw-session", date, filename],
    queryFn: () => apiGet<RawSessionDetail>(`/raw/${encodeURIComponent(date)}/${encodeURIComponent(filename)}`),
    enabled: date.length > 0 && filename.length > 0,
    staleTime: 60_000,
  });
}
