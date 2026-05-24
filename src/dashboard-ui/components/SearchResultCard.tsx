import { Link } from "@tanstack/react-router";
import { type SearchResult } from "../hooks/useSearch.js";
import { cn } from "../lib/cn.js";
import { Card } from "./Card.js";
import { ScoreBreakdown } from "./ScoreBreakdown.js";

const KIND_COLOR: Record<string, string> = {
  wiki: "bg-entity-projects",
  raw: "bg-entity-raw-session",
  crystal: "bg-entity-crystals",
};

type ResultLinkProps =
  | { to: "/wiki/$category/$slug"; params: { category: string; slug: string } }
  | { to: "/raw/$date/$filename"; params: { date: string; filename: string } };

export function SearchResultCard({ result }: { result: SearchResult }) {
  const linkProps = resultLinkProps(result);

  return (
    <Card className="transition-colors hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn("mt-1.5 h-2 w-2 flex-shrink-0 rounded-full", KIND_COLOR[result.kind] ?? "bg-text-muted")}
        />
        <div className="min-w-0 flex-1">
          {linkProps ? (
            <Link {...linkProps} className="block">
              <h3 className="truncate text-base font-semibold text-text-primary hover:underline">
                {result.title}
              </h3>
            </Link>
          ) : (
            <h3 className="truncate text-base font-semibold text-text-primary">{result.title}</h3>
          )}
          <p className="mb-2 truncate font-mono text-xs text-text-muted">{result.path}</p>
          <p className="mb-3 line-clamp-2 text-sm text-text-secondary">{result.snippet}</p>
          <ScoreBreakdown sources={result.sources} />
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="text-xs uppercase tracking-wider text-text-muted">Score</p>
          <p className="font-mono text-lg font-semibold">{result.score.toFixed(2)}</p>
          <p className="font-mono text-[10px] text-text-muted">{result.source}</p>
        </div>
      </div>
    </Card>
  );
}

function resultLinkProps(result: SearchResult): ResultLinkProps | null {
  if (result.kind === "wiki" && result.path.startsWith("wiki/")) {
    const parts = result.path.replace(/^wiki\//, "").replace(/\.md$/, "").split("/");
    if (parts.length >= 2) {
      return {
        to: "/wiki/$category/$slug",
        params: { category: parts[0] ?? "", slug: parts.slice(1).join("/") },
      };
    }
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
  return null;
}
