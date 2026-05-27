import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export type EnvVarStatus = "set" | "missing";

export interface ProviderCatalogModel {
  id: string;
  default?: boolean;
  dim?: number;
  free?: boolean;
}

export interface ProviderCatalogEntry {
  provider: string;
  envVar: string;
  envVarStatus: EnvVarStatus;
  models: ProviderCatalogModel[];
}

export interface ProvidersCatalog {
  embedders: ProviderCatalogEntry[];
  llms: ProviderCatalogEntry[];
}

export function useProvidersCatalog() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<ProvidersCatalog>("/providers"),
    staleTime: 60_000,
  });
}
