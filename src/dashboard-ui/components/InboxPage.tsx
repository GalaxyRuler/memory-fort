import { Check, ChevronRight, Inbox, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "./Button.js";
import { Card } from "./Card.js";
import { EmptyState } from "./EmptyState.js";
import {
  type ProposedDraft,
  useProposedAction,
  useProposedCompile,
  useProposedProcedures,
  useProposedSummary,
  useProposedThreads,
} from "../hooks/useProposed.js";
import { useStatus } from "../hooks/useStatus.js";
import { cn } from "../lib/cn.js";

export function InboxPage() {
  const threads = useProposedThreads();
  const procedures = useProposedProcedures();
  const compile = useProposedCompile();
  const summary = useProposedSummary();
  const action = useProposedAction();
  const status = useStatus();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const readOnlyReason = status.data?.capabilities?.writable === false
    ? status.data.capabilities.reason ?? "vault is read-only"
    : null;
  const disabledReason = status.isLoading ? "Checking dashboard write capability..." : readOnlyReason;

  const threadDrafts = useMemo(
    () => (threads.data ?? []).filter((draft) => !hidden.has(draftKey(draft))),
    [threads.data, hidden],
  );
  const procedureDrafts = useMemo(
    () => (procedures.data ?? []).filter((draft) => !hidden.has(draftKey(draft))),
    [procedures.data, hidden],
  );
  const compileDrafts = useMemo(
    () => (compile.data ?? []).filter((draft) => !hidden.has(draftKey(draft))),
    [compile.data, hidden],
  );
  const isLoading = threads.isLoading || procedures.isLoading || compile.isLoading;
  const hasError = threads.error || procedures.error || compile.error;
  const total = threadDrafts.length + procedureDrafts.length + compileDrafts.length;

  const runAction = (draft: ProposedDraft, nextAction: "promote" | "reject") => {
    if (disabledReason) {
      setNotice(disabledReason);
      return;
    }
    if (draft.kind === "compile") {
      setNotice("Compile proposals are staged for manual review.");
      return;
    }
    if (nextAction === "reject" && !window.confirm(`Reject ${draft.title}?`)) return;
    setHidden((current) => new Set(current).add(draftKey(draft)));
    action.mutate(
      { action: nextAction, kind: draft.kind, slug: draft.slug },
      {
        onSuccess: () => {
          setNotice(`${nextAction === "promote" ? "Promoted" : "Rejected"} ${draft.title}.`);
        },
        onError: (error) => {
          setHidden((current) => {
            const next = new Set(current);
            next.delete(draftKey(draft));
            return next;
          });
          setNotice(error instanceof Error ? error.message : "Draft action failed.");
        },
      },
    );
  };

  if (isLoading) return <div className="p-4 text-sm text-text-muted md:p-6">Loading inbox...</div>;
  if (hasError) return <div className="p-4 text-sm text-status-red md:p-6">Failed to load proposed drafts.</div>;

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="break-words text-2xl font-semibold tracking-tight">Inbox</h1>
          <p className="text-sm text-text-secondary">Review proposed threads and procedures that need an operator decision.</p>
        </div>
        {notice && (
          <div role="status" className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm text-text-secondary">
            {notice}
          </div>
        )}
      </header>

      {readOnlyReason ? (
        <div className="mb-4 rounded-md border border-status-amber/30 bg-status-amber/10 p-3 text-sm text-status-amber">
          {readOnlyReason}
        </div>
      ) : null}

      {total === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Inbox zero"
          description={`Auto-promote handled ${summary.data?.recentAutoPromoted ?? 0} drafts in the last 7 days.`}
        />
      ) : (
        <div className="space-y-5">
          <DraftSection
            title="Threads awaiting review"
            drafts={threadDrafts}
            disabledReason={disabledReason}
            onPromote={(draft) => runAction(draft, "promote")}
            onReject={(draft) => runAction(draft, "reject")}
          />
          <DraftSection
            title="Procedures awaiting review"
            drafts={procedureDrafts}
            disabledReason={disabledReason}
            onPromote={(draft) => runAction(draft, "promote")}
            onReject={(draft) => runAction(draft, "reject")}
          />
          <DraftSection
            title="Compile proposals"
            drafts={compileDrafts}
            disabledReason={disabledReason}
            onPromote={(draft) => runAction(draft, "promote")}
            onReject={(draft) => runAction(draft, "reject")}
          />
        </div>
      )}
    </div>
  );
}

function DraftSection({
  title,
  drafts,
  disabledReason,
  onPromote,
  onReject,
}: {
  title: string;
  drafts: ProposedDraft[];
  disabledReason: string | null;
  onPromote: (draft: ProposedDraft) => void;
  onReject: (draft: ProposedDraft) => void;
}) {
  return (
    <details open className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-base font-semibold">
        <ChevronRight size={16} strokeWidth={1.5} className="transition-transform group-open:rotate-90" />
        {title}
        <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-text-muted">{drafts.length}</span>
      </summary>
      <div className="grid gap-3">
        {drafts.length === 0 ? (
          <p className="rounded-md border border-border-subtle bg-surface/60 p-3 text-sm text-text-muted">No drafts in this section.</p>
        ) : (
          drafts.map((draft) => (
            <DraftCard
              key={draftKey(draft)}
              draft={draft}
              disabledReason={disabledReason}
              onPromote={onPromote}
              onReject={onReject}
            />
          ))
        )}
      </div>
    </details>
  );
}

function DraftCard({
  draft,
  disabledReason,
  onPromote,
  onReject,
}: {
  draft: ProposedDraft;
  disabledReason: string | null;
  onPromote: (draft: ProposedDraft) => void;
  onReject: (draft: ProposedDraft) => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="break-words text-base font-semibold">{draft.title}</h2>
            <ConfidenceBadge draft={draft} />
          </div>
          <p className="text-sm text-text-secondary">{draft.prosePreview}</p>
        </div>
        {draft.kind !== "compile" && (
          <div className="flex flex-wrap gap-2">
            <Button
              className="border-status-green/60 text-status-green hover:bg-status-green/10 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={disabledReason !== null}
              title={disabledReason ?? undefined}
              onClick={() => onPromote(draft)}
            >
              <Check size={14} strokeWidth={1.5} />
              Promote
            </Button>
            <Button
              className="border-status-red/60 text-status-red hover:bg-status-red/10 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={disabledReason !== null}
              title={disabledReason ?? undefined}
              onClick={() => onReject(draft)}
            >
              <Trash2 size={14} strokeWidth={1.5} />
              Reject
            </Button>
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
        <span>{draft.observationCount} observations</span>
        <span>{draft.distinctSessions} sessions</span>
        {draft.kind === "thread" && draft.timeRange && (
          <span>{draft.timeRange.start}{draft.timeRange.end ? ` to ${draft.timeRange.end}` : ""}</span>
        )}
        {draft.kind === "procedure" && <span>{draft.steps} steps</span>}
        {draft.kind === "compile" && draft.targetPath && <span>{draft.targetPath}</span>}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-text-secondary">Expand draft</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-surface-2 p-3 whitespace-pre-wrap text-xs text-text-primary">
          {draft.body}
        </pre>
      </details>
    </Card>
  );
}

function ConfidenceBadge({ draft }: { draft: ProposedDraft }) {
  const high = draft.confidence.level === "high";
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 text-xs font-medium",
        high ? "bg-status-green/10 text-status-green" : "bg-status-amber/10 text-status-amber",
      )}
      title={draft.confidence.reasons.join("; ")}
    >
      {high ? "High confidence" : `Low confidence: ${draft.confidence.reasons.join("; ")}`}
    </span>
  );
}

function draftKey(draft: ProposedDraft): string {
  return `${draft.kind}:${draft.slug}`;
}
