import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export type ConfigValue = string | number | boolean | null | ConfigObject | ConfigValue[];

export interface ConfigObject {
  [key: string]: ConfigValue;
}

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => apiGet<ConfigObject>("/config"),
    staleTime: 60_000,
  });
}
