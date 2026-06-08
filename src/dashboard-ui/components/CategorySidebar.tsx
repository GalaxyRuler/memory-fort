import { type WikiIndex } from "../hooks/useWikiIndex.js";
import { cn } from "../lib/cn.js";
import { Card } from "./Card.js";

export const CONFIGURED_WIKI_CATEGORIES = [
  "decisions",
  "projects",
  "issues",
  "lessons",
  "references",
  "tools",
  "people",
  "threads",
  "procedures",
  "crystals",
];

const CATEGORY_COLORS: Record<string, string> = {
  issues: "bg-entity-decisions",
  projects: "bg-entity-projects",
  decisions: "bg-entity-decisions",
  lessons: "bg-entity-lessons",
  references: "bg-entity-references",
  tools: "bg-entity-tools",
  people: "bg-entity-people",
  crystals: "bg-entity-crystals",
};

export interface CategorySidebarProps {
  index: WikiIndex | undefined;
  selectedCategory: string | null;
  onSelect: (category: string | null) => void;
}

export function CategorySidebar({ index, selectedCategory, onSelect }: CategorySidebarProps) {
  const categories = getVisibleWikiCategories(index?.byCategory);
  const totalCount = getVisibleWikiCategoryTotal(index?.byCategory);

  return (
    <Card className="space-y-1 md:sticky md:top-4">
      <button
        className={cn(
          "flex min-h-11 w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition-colors md:min-h-8 md:py-1.5",
          selectedCategory === null
            ? "bg-surface-2 text-text-primary"
            : "text-text-secondary hover:bg-surface-2/50 hover:text-text-primary",
        )}
        onClick={() => onSelect(null)}
        type="button"
      >
        <span>All</span>
        <span className="font-mono text-xs text-text-muted">{totalCount}</span>
      </button>
      <div className="my-1 border-t border-border-subtle" />
      {categories.map((category) => (
        <button
          key={category}
          className={cn(
            "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors md:min-h-8 md:py-1.5",
            selectedCategory === category
              ? "bg-surface-2 text-text-primary"
              : "text-text-secondary hover:bg-surface-2/50 hover:text-text-primary",
          )}
          onClick={() => onSelect(category)}
          type="button"
        >
          <span
            aria-hidden
            className={cn("h-1.5 w-1.5 rounded-full", CATEGORY_COLORS[category] ?? "bg-text-muted")}
          />
          <span className="flex-1 capitalize">{category}</span>
          <span className="font-mono text-xs text-text-muted">{index?.byCategory[category]?.length ?? 0}</span>
        </button>
      ))}
    </Card>
  );
}

export function getVisibleWikiCategories(byCategory: WikiIndex["byCategory"] | undefined): string[] {
  const configuredCategories = [...CONFIGURED_WIKI_CATEGORIES];
  const extraCategories = Object.keys(byCategory ?? {})
    .filter((category) => !CONFIGURED_WIKI_CATEGORIES.includes(category))
    .sort();
  return [...configuredCategories, ...extraCategories];
}

export function getVisibleWikiCategoryTotal(byCategory: WikiIndex["byCategory"] | undefined): number {
  return getVisibleWikiCategories(byCategory).reduce(
    (total, category) => total + (byCategory?.[category]?.length ?? 0),
    0,
  );
}
