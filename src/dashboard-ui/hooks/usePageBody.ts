import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export interface PageBody {
  relPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  relations: Array<{ target: string; label?: string | null }>;
  inbound: Array<{ source: string; label?: string | null }>;
}

export function usePageBody(path: string, enabled = true) {
  return useQuery({
    queryKey: ["page-body", path],
    queryFn: () => apiGet<PageBody>(`/page/${encodeURIComponent(path)}`),
    enabled: enabled && path.length > 0,
    staleTime: 30_000,
  });
}
