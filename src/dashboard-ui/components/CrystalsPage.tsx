import { Link } from "@tanstack/react-router";
import { useWikiIndex } from "../hooks/useWikiIndex.js";
import { Card } from "./Card.js";
import { CrystalRotatingIcon } from "./CrystalRotatingIcon.js";

export function CrystalsPage() {
  const wiki = useWikiIndex();
  const crystals = wiki.data?.byCategory.crystal ?? [];

  return (
    <div className="mx-auto max-w-7xl p-6">
      <header className="mb-6 flex items-center gap-3">
        <CrystalRotatingIcon className="h-10 w-10" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Crystals</h1>
          <p className="text-sm text-text-secondary">
            Distilled long-form digests from completed work threads. {crystals.length} crystal
            {crystals.length === 1 ? "" : "s"}.
          </p>
        </div>
      </header>

      {wiki.isLoading && <p className="text-sm text-text-muted">Loading crystals...</p>}
      {!wiki.isLoading && crystals.length === 0 && (
        <Card className="py-12 text-center">
          <CrystalRotatingIcon className="mb-3 inline-flex h-12 w-12" />
          <h2 className="mb-2 text-lg font-semibold">No crystals yet</h2>
          <p className="mx-auto max-w-md text-sm text-text-secondary">
            Crystals are long-form digests distilled from completed work threads. Run{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">memory crystallize</code> to create one.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {crystals.map((crystal) => (
          <Link
            key={crystal.relPath}
            to="/wiki/$category/$slug"
            params={{ category: "crystal", slug: crystal.slug }}
            className="block rounded-lg border border-border-subtle bg-surface p-4 transition-all hover:border-border-emphasis hover:bg-surface-2"
          >
            <div className="mb-2 flex items-start gap-3">
              <CrystalRotatingIcon className="mt-0.5 h-6 w-6 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-base font-semibold text-text-primary">{crystal.title}</h3>
                <p className="font-mono text-xs text-text-muted">{crystal.updated}</p>
              </div>
            </div>
            <p className="ml-9 line-clamp-3 text-sm text-text-secondary">{crystal.summary || "(no summary)"}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
