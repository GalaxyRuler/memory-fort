import { useNavigate, useSearch } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { useWikiIndex } from "../hooks/useWikiIndex.js";
import { CategorySidebar } from "./CategorySidebar.js";
import { EmptyState } from "./EmptyState.js";
import { Skeleton } from "./Skeleton.js";
import { WikiCard } from "./WikiCard.js";

export function WikiBrowsePage() {
  const wiki = useWikiIndex();
  const params = useSearch({ from: "/wiki" }) as { category?: string };
  const navigate = useNavigate({ from: "/wiki" });
  const selectedCategory = params.category ?? null;
  const entries = selectedCategory
    ? wiki.data?.byCategory[selectedCategory] ?? []
    : Object.values(wiki.data?.byCategory ?? {}).flat();
  const listNav = useListKeyNav({
    items: entries,
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" {...listNav.listProps}>
            {entries.map((entry, index) => (
              <WikiCard entry={entry} key={entry.relPath} keyboardProps={listNav.getItemProps(index)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
