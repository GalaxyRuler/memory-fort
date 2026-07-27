import { Link } from "@tanstack/react-router";
import { type HTMLAttributes, useState } from "react";
import { type SearchResult } from "../hooks/useSearch.js";
import { cn } from "../lib/cn.js";
import { apiPost } from "../lib/api.js";
import { hasArchivePathComponent } from "../lib/archive-paths.js";
import { formatSearchSourceLabel, normalizeSearchSignals } from "../lib/search-sources.js";
import { BottomSheet } from "./BottomSheet.js";
import { Card } from "./Card.js";
import { ScoreBreakdown } from "./ScoreBreakdown.js";

const KIND_COLOR: Record<string, string> = {
  wiki: "bg-entity-projects",
  raw: "bg-entity-raw-session",
  crystal: "bg-entity-crystals",
};

export type ResultLinkProps =
  | {
    to: "/wiki/$category/$slug";
    params: { category: string; slug: string };
    search?: { includeArchived: 1 };
  }
  | { to: "/raw/$date/$filename"; params: { date: string; filename: string } }
  | { to: "/crystals" };

export function SearchResultCard({
  result,
  keyboardProps,
}: {
  result: SearchResult;
  keyboardProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const [isScoreOpen, setIsScoreOpen] = useState(false);
  const [resolution, setResolution] = useState<{
    valid: boolean;
    reason: string;
    text: string | null;
    byteStart: number | null;
    byteEnd: number | null;
  } | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const linkProps = resultLinkProps(result);
  const signals = normalizeSearchSignals(result.provenance.signals);
  const sourceLabel = formatSearchSourceLabel(result.source);

  return (
    <Card
      className="transition-colors hover:bg-surface-2 data-[focused=true]:bg-surface-2 data-[focused=true]:ring-1 data-[focused=true]:ring-primary/60"
      {...keyboardProps}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <span
          aria-hidden
          className={cn("hidden h-2 w-2 flex-shrink-0 rounded-full md:mt-1.5 md:block", KIND_COLOR[result.kind] ?? "bg-text-muted")}
        />
        <div className="min-w-0 flex-1">
          {linkProps ? (
            <Link {...linkProps} className="block">
              <h3 className="break-words text-base font-semibold text-text-primary hover:underline md:truncate">
                {result.title}
              </h3>
            </Link>
          ) : (
            <h3 className="break-words text-base font-semibold text-text-primary md:truncate">{result.title}</h3>
          )}
          <p className="mb-2 break-all font-mono text-xs text-text-muted md:truncate">{result.path}</p>
          <p className="mb-3 line-clamp-2 text-sm text-text-secondary">{result.snippet}</p>
          {signals.length > 0 ? (
            <details className="mt-3 text-xs text-text-muted">
              <summary className="cursor-pointer font-medium text-text-secondary">Why this matched</summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {signals.map((signal, index) => {
                  const label = formatSearchSourceLabel(signal.source);
                  return (
                    <span
                      key={`${signal.source}-${signal.rank}-${index}`}
                      className="max-w-full break-all rounded border border-border-subtle px-1.5 py-0.5 font-mono"
                    >
                      {label} rank {signal.rank}
                    </span>
                  );
                })}
              </div>
            </details>
          ) : null}
          {hasResolvableReceipt(result) ? (
            <div className="mt-3 text-xs">
              <button
                type="button"
                className="rounded border border-border-subtle px-2 py-1 text-text-secondary"
                onClick={async () => {
                  setResolution(null);
                  setResolutionError(null);
                  try {
                    setResolution(await apiPost("/search/provenance/resolve", result.provenance));
                  } catch (error) {
                    setResolutionError(error instanceof Error ? error.message : "Receipt could not be verified");
                  }
                }}
              >
                Why this result?
              </button>
              {resolution?.valid ? (
                <div className="mt-2 rounded border border-border-subtle bg-surface-2 p-2">
                  <p className="font-medium text-text-secondary">
                    Verified bytes {resolution.byteStart}–{resolution.byteEnd}
                  </p>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-text-muted">
                    {resolution.text}
                  </pre>
                </div>
              ) : resolution ? (
                <p className="mt-2 text-status-red">Receipt unavailable: {resolution.reason}</p>
              ) : resolutionError ? (
                <p className="mt-2 text-status-red">Receipt unavailable: {resolutionError}</p>
              ) : null}
            </div>
          ) : null}
          <ScoreBreakdown className="hidden md:flex" sources={result.sources} />
        </div>
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border-subtle pt-3 md:block md:border-t-0 md:pt-0 md:text-right">
          <div>
            <p className="text-xs uppercase tracking-wider text-text-muted">Score</p>
            <p className="font-mono text-lg font-semibold">{result.score.toFixed(2)}</p>
            <p className="break-words font-mono text-[10px] text-text-muted">{sourceLabel}</p>
          </div>
          <button
            type="button"
            className="min-h-11 rounded-md border border-border-subtle px-3 text-xs text-text-secondary md:hidden"
            onClick={() => setIsScoreOpen(true)}
          >
            Details
          </button>
        </div>
      </div>
      <BottomSheet isOpen={isScoreOpen} onClose={() => setIsScoreOpen(false)} title="Score details">
        <ScoreBreakdown sources={result.sources} />
      </BottomSheet>
    </Card>
  );
}

function hasResolvableReceipt(result: SearchResult): boolean {
  const receipt = result.provenance;
  return (
    typeof receipt.chunkId === "string" &&
    Number.isSafeInteger(receipt.byteStart) &&
    Number.isSafeInteger(receipt.byteEnd) &&
    typeof receipt.sourceContentHash === "string" &&
    typeof receipt.chunkTextHash === "string"
  );
}

export function resultLinkProps(result: SearchResult): ResultLinkProps | null {
  if (result.kind === "wiki" && result.path.startsWith("wiki/")) {
    return wikiLinkFromPath(result.path);
  }
  if (result.kind === "raw" && result.path.startsWith("raw/")) {
    const parts = result.path.replace(/^raw\//, "").split("/");
    if (parts.length >= 2) {
      return {
        to: "/raw/$date/$filename",
        params: { date: parts[0] ?? "", filename: parts.slice(1).join("/") },
      };
    }
  }
  if (result.kind === "crystal") {
    return crystalLinkFromPath(result.path) ?? { to: "/crystals" };
  }
  return null;
}

function crystalLinkFromPath(path: string): ResultLinkProps | null {
  const normalized = normalizeMarkdownPath(path);
  if (normalized.startsWith("wiki/crystals/")) {
    return wikiLinkFromParts("crystals", normalized.replace(/^wiki\/crystals\//, ""));
  }
  return null;
}

function wikiLinkFromPath(path: string): ResultLinkProps | null {
  const normalized = normalizeMarkdownPath(path);
  const parts = normalized.replace(/^wiki\//, "").split("/");
  if (parts.length < 2) return null;
  return wikiLinkFromParts(
    parts[0] ?? "",
    parts.slice(1).join("/"),
    hasArchivePathComponent(normalized),
  );
}

function wikiLinkFromParts(category: string, slug: string, includeArchived = false): ResultLinkProps | null {
  if (!category || !slug) return null;
  return {
    to: "/wiki/$category/$slug",
    params: { category, slug },
    ...(includeArchived ? { search: { includeArchived: 1 as const } } : {}),
  };
}

function normalizeMarkdownPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/, "");
}
