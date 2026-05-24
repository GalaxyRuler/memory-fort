import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export interface RawIndexFile {
  filename: string;
  sizeBytes: number;
  mtime: string;
}

export interface RawIndexEntry {
  date: string;
  files: RawIndexFile[];
}

export function useRawIndex() {
  return useQuery({
    queryKey: ["raw-index"],
    queryFn: () => apiGet<RawIndexEntry[]>("/raw"),
    staleTime: 30_000,
  });
}
