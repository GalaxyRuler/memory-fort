import { Link } from "@tanstack/react-router";
import { type HTMLAttributes, useState } from "react";
import { type SearchResult } from "../hooks/useSearch.js";
import { cn } from "../lib/cn.js";
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
  | { to: "/wiki/$category/$slug"; params: { category: string; slug: string } }
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

export function resultLinkProps(result: SearchResult): ResultLinkProps | null {
  if (result.kind === "wiki" && result.path.startsWith("wiki/")) {
    return wikiLinkFromPath(result.path);
  }
  if (result.kind === "raw" && result.path.startsWith("raw/")) {
    const parts = result.path.replace(/^raw\//, "").replace(/\.md$/, "").split("/");
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
  if (normalized.startsWith("crystals/")) {
    return wikiLinkFromParts("crystals", normalized.replace(/^crystals\//, ""));
  }
  return null;
}

function wikiLinkFromPath(path: string): ResultLinkProps | null {
  const parts = normalizeMarkdownPath(path).replace(/^wiki\//, "").split("/");
  if (parts.length < 2) return null;
  return wikiLinkFromParts(parts[0] ?? "", parts.slice(1).join("/"));
}

function wikiLinkFromParts(category: string, slug: string): ResultLinkProps | null {
  if (!category || !slug) return null;
  return {
    to: "/wiki/$category/$slug",
    params: { category, slug },
  };
}

function normalizeMarkdownPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/, "");
}
