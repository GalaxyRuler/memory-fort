import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientIntegrationStatus } from "../../clients/status.js";
import type { ConfigurableClientId } from "../../clients/catalog.js";
import { apiGet, apiPost } from "../lib/api.js";

export type ClientAction = "install" | "repair" | "disconnect";

export function useClientStatuses() {
  return useQuery({
    queryKey: ["clients", "status"],
    queryFn: () => apiGet<ClientIntegrationStatus[]>("/clients/status"),
    staleTime: 30_000,
  });
}

export function useClientAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, client }: { action: ClientAction; client: ConfigurableClientId }) =>
      apiPost<{ ok: boolean; action: ClientAction; client: ConfigurableClientId; detail: string }>("/clients/action", { action, client }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients", "status"] }),
  });
}
