import { Link } from "@tanstack/react-router";
import { type WikiIndexEntry } from "../hooks/useWikiIndex.js";
import { cn } from "../lib/cn.js";

const CATEGORY_COLORS: Record<string, string> = {
  projects: "border-t-entity-projects",
  decisions: "border-t-entity-decisions",
  lessons: "border-t-entity-lessons",
  references: "border-t-entity-references",
  tools: "border-t-entity-tools",
  people: "border-t-entity-people",
  crystals: "border-t-entity-crystals",
};

export function WikiCard({ entry }: { entry: WikiIndexEntry }) {
  return (
    <Link
      className={cn(
        "block rounded-lg border border-t-4 border-border-subtle bg-surface p-4 transition-colors hover:bg-surface-2",
        CATEGORY_COLORS[entry.category] ?? "border-t-text-muted",
      )}
      params={{ category: entry.category, slug: entry.slug }}
      to="/wiki/$category/$slug"
    >
      <h3 className="mb-1 break-words text-base font-semibold text-text-primary md:truncate">{entry.title}</h3>
      <p className="mb-3 line-clamp-2 text-sm text-text-secondary">{entry.summary || "(no summary)"}</p>
      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-text-muted">
        <span className="break-words">{entry.updated}</span>
        <span className="capitalize">{entry.category}</span>
      </div>
    </Link>
  );
}
