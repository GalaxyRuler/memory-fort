import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "../lib/api.js";

export interface SecretMeta { present: boolean; last4?: string }
export type SecretsResponse = Record<string, SecretMeta>;

export function useSecrets() {
  return useQuery({
    queryKey: ["secrets"],
    queryFn: () => apiGet<SecretsResponse>("/secrets"),
    staleTime: 60_000,
  });
}

export function useUpdateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { provider: string; key: string }) =>
      apiPut<{ ok: true }>("/secrets", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["secrets"] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
