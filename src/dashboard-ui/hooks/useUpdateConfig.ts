import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPatch } from "../lib/api.js";

export interface ConfigPatchBody {
  embedder?: {
    provider?: "voyage" | "openai" | "ollama";
    model?: string;
    options?: Record<string, unknown>;
  };
  llm?: {
    provider?: "openrouter" | "ollama";
    model?: string;
    max_tokens?: number;
    temperature?: number;
    options?: Record<string, unknown>;
  };
  auto_promote?: {
    enabled?: boolean;
    cadence?: "weekly" | "daily" | "manual";
    confidence_threshold?: "high" | "none";
  };
  compile?: {
    scheduled?: boolean;
    cadence?: "daily" | "weekly" | "manual";
  };
  clients?: Record<string, boolean>;
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConfigPatchBody) => apiPatch<{ ok: true; applied: string[] }>("/config", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
