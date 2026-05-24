import { useNavigate, useSearch } from "@tanstack/react-router";
import { useWikiIndex } from "../hooks/useWikiIndex.js";
import { CategorySidebar } from "./CategorySidebar.js";
import { WikiCard } from "./WikiCard.js";

export function WikiBrowsePage() {
  const wiki = useWikiIndex();
  const params = useSearch({ from: "/wiki" }) as { category?: string };
  const navigate = useNavigate({ from: "/wiki" });
  const selectedCategory = params.category ?? null;
  const entries = selectedCategory
    ? wiki.data?.byCategory[selectedCategory] ?? []
    : Object.values(wiki.data?.byCategory ?? {}).flat();

  return (
    <div className="mx-auto max-w-7xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Wiki</h1>
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
          {wiki.isLoading ? <p className="px-2 text-sm text-text-muted">Loading wiki...</p> : null}
          {wiki.data && entries.length === 0 ? (
            <p className="px-2 text-sm text-text-muted">No pages in this category.</p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((entry) => (
              <WikiCard entry={entry} key={entry.relPath} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
