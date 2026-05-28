import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../lib/api.js";

export interface ProposalConfidence {
  level: "high" | "low";
  reasons: string[];
}

export interface ProposedThreadDraft {
  kind: "thread";
  slug: string;
  title: string;
  observationCount: number;
  distinctSessions: number;
  confidence: ProposalConfidence;
  prosePreview: string;
  body: string;
  timeRange: { start: string; end?: string | null } | null;
}

export interface ProposedProcedureDraft {
  kind: "procedure";
  slug: string;
  title: string;
  observationCount: number;
  distinctSessions: number;
  confidence: ProposalConfidence;
  prosePreview: string;
  body: string;
  commandSignature: string[];
  steps: number;
}

export type ProposedDraft = ProposedThreadDraft | ProposedProcedureDraft;

export interface ProposedSummary {
  threads: { total: number; high: number; low: number };
  procedures: { total: number; high: number; low: number };
  total: number;
  recentAutoPromoted: number;
}

export function useProposedThreads() {
  return useQuery({
    queryKey: ["proposed", "threads"],
    queryFn: () => apiGet<ProposedThreadDraft[]>("/proposed/threads"),
    staleTime: 15_000,
  });
}

export function useProposedProcedures() {
  return useQuery({
    queryKey: ["proposed", "procedures"],
    queryFn: () => apiGet<ProposedProcedureDraft[]>("/proposed/procedures"),
    staleTime: 15_000,
  });
}

export function useProposedSummary() {
  return useQuery({
    queryKey: ["proposed", "summary"],
    queryFn: () => apiGet<ProposedSummary>("/proposed/summary"),
    staleTime: 15_000,
  });
}

export function useProposedAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { action: "promote" | "reject"; kind: "thread" | "procedure"; slug: string }) =>
      apiPost<{ ok: true; promotedPath?: string; rejectedPath?: string }>(`/proposed/${input.action}`, {
        kind: input.kind,
        slug: input.slug,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposed"] });
    },
  });
}
