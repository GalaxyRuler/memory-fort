import { useMutation, useQueryClient } from "@tanstack/react-query";

interface SyncNowResult {
  ok: boolean;
  error?: string;
  autoCommit?: { kind: string; filesCount?: number; commitSha?: string };
  sync?: { initialState: string; finalState: string; actionsPerformed: string[] };
}

export function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<SyncNowResult> => {
      const res = await fetch("/memory/api/sync", { method: "POST" });
      return res.json() as Promise<SyncNowResult>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void queryClient.invalidateQueries({ queryKey: ["verify"] });
    },
  });
}
