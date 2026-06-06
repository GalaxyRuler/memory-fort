import { useNavigate, useSearch } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { useWikiIndex } from "../hooks/useWikiIndex.js";
import { CategorySidebar } from "./CategorySidebar.js";
import { EmptyState } from "./EmptyState.js";
import { Skeleton } from "./Skeleton.js";
import { WikiCard } from "./WikiCard.js";

const CATEGORY_ORDER = [
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

const CATEGORY_LABELS: Record<string, string> = {
  decisions: "Decisions",
  projects: "Projects",
  issues: "Issues",
  lessons: "Lessons",
  references: "References",
  tools: "Tools",
  people: "People",
  threads: "Threads",
  procedures: "Procedures",
  crystals: "Crystals",
};

export function WikiBrowsePage() {
  const wiki = useWikiIndex();
  const params = useSearch({ from: "/wiki/" }) as { category?: string };
  const navigate = useNavigate({ from: "/wiki/" });
  const selectedCategory = params.category ?? null;
  const entries = selectedCategory
    ? wiki.data?.byCategory[selectedCategory] ?? []
    : Object.values(wiki.data?.byCategory ?? {}).flat();
  const groups = selectedCategory ? [] : groupedEntries(wiki.data?.byCategory ?? {});
  const navEntries = selectedCategory ? entries : groups.flatMap((group) => group.entries);
  const navIndexByRelPath = new Map(navEntries.map((entry, index) => [entry.relPath, index]));
  const listNav = useListKeyNav({
    items: navEntries,
    getKey: (entry) => entry.relPath,
    onActivate: (entry) =>
      navigate({
        to: "/wiki/$category/$slug",
        params: { category: entry.category, slug: entry.slug },
      }),
  });

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-6">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Wiki</h1>
        <p className="text-sm text-text-secondary">{wiki.data?.total ?? 0} curated pages</p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[256px_1fr]">
        <CategorySidebar
          index={wiki.data}
          onSelect={(category) =>
            navigate({
              search: { category: category ?? undefined },
              replace: true,
            })
          }
          selectedCategory={selectedCategory}
        />
        <div>
          {wiki.isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading wiki">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} variant="card" />
              ))}
            </div>
          ) : null}
          {wiki.data && entries.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No pages in this category"
              description="Try another category to browse curated wiki pages."
            />
          ) : null}
          {selectedCategory ? (
            <ul
              aria-label="Wiki pages"
              className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3"
              {...listNav.listProps}
            >
              {entries.map((entry, index) => (
                <WikiCard entry={entry} key={entry.relPath} keyboardProps={listNav.getItemProps(index)} />
              ))}
            </ul>
          ) : (
            <div aria-label="Wiki pages keyboard navigation" className="space-y-8" role="region" {...listNav.listProps}>
              {groups.map((group) => (
                <section key={group.category}>
                  <h2 className="mb-3 break-words text-lg font-semibold tracking-tight" id={`wiki-group-${group.category}`}>
                    {CATEGORY_LABELS[group.category] ?? titleCase(group.category)}
                  </h2>
                  <ul
                    aria-labelledby={`wiki-group-${group.category}`}
                    className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3"
                  >
                    {group.entries.map((entry) => (
                      <WikiCard
                        entry={entry}
                        key={entry.relPath}
                        keyboardProps={listNav.getItemProps(navIndexByRelPath.get(entry.relPath) ?? 0)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function groupedEntries(byCategory: NonNullable<ReturnType<typeof useWikiIndex>["data"]>["byCategory"]) {
  const categoryKeys = [
    ...CATEGORY_ORDER,
    ...Object.keys(byCategory).filter((category) => !CATEGORY_ORDER.includes(category)).sort(),
  ];
  return categoryKeys
    .map((category) => ({
      category,
      entries: byCategory[category] ?? [],
    }))
    .filter((group) => group.entries.length > 0);
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
