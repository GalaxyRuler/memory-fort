import { Link, useNavigate } from "@tanstack/react-router";
import { Gem } from "lucide-react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { useWikiIndex } from "../hooks/useWikiIndex.js";
import { CrystalRotatingIcon } from "./CrystalRotatingIcon.js";
import { EmptyState } from "./EmptyState.js";

export function CrystalsPage() {
  const wiki = useWikiIndex();
  const navigate = useNavigate({ from: "/crystals" });
  const crystals = wiki.data?.byCategory.crystals ?? [];
  const listNav = useListKeyNav({
    items: crystals,
    getKey: (crystal) => crystal.relPath,
    onActivate: (crystal) =>
      navigate({
        to: "/wiki/$category/$slug",
        params: { category: "crystals", slug: crystal.slug },
      }),
  });

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-6 flex items-start gap-3">
        <CrystalRotatingIcon className="h-10 w-10" />
        <div>
          <h1 className="break-words text-2xl font-semibold tracking-tight">Crystals</h1>
          <p className="text-sm text-text-secondary">
            Distilled long-form digests from completed work threads. {crystals.length} crystal
            {crystals.length === 1 ? "" : "s"}.
          </p>
        </div>
      </header>

      {wiki.isLoading && <p className="text-sm text-text-muted">Loading crystals...</p>}
      {!wiki.isLoading && crystals.length === 0 && (
        <EmptyState
          icon={Gem}
          title="No crystals yet"
          description={
            <>
              Crystals are long-form digests distilled from completed work threads. Run{" "}
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">memory crystallize</code> to create one.
            </>
          }
          className="py-12"
        />
      )}

      <ul aria-label="Crystals" className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2" {...listNav.listProps}>
        {crystals.map((crystal, index) => (
          <li
            key={crystal.relPath}
            className="rounded-lg border border-border-subtle bg-surface transition-all hover:border-border-emphasis hover:bg-surface-2 data-[focused=true]:border-primary/60 data-[focused=true]:bg-surface-2 data-[focused=true]:ring-1 data-[focused=true]:ring-primary/60"
            {...listNav.getItemProps(index)}
          >
            <Link
              to="/wiki/$category/$slug"
              params={{ category: "crystals", slug: crystal.slug }}
              className="block h-full rounded-lg p-4 focus:outline-none"
              tabIndex={-1}
            >
              <div className="mb-2 flex items-start gap-3">
                <CrystalRotatingIcon className="mt-0.5 h-6 w-6 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-base font-semibold text-text-primary md:truncate">{crystal.title}</h3>
                  <p className="break-words font-mono text-xs text-text-muted">{crystal.updated}</p>
                </div>
              </div>
              <p className="ml-9 line-clamp-3 text-sm text-text-secondary">{crystal.summary || "(no summary)"}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
