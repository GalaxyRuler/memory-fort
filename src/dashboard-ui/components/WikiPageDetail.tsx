import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { usePageDetail } from "../hooks/usePageDetail.js";
import { preprocessWikilinks } from "../lib/wikilinks.js";
import { BottomSheet } from "./BottomSheet.js";
import { Button } from "./Button.js";
import { MarkdownBody } from "./MarkdownBody.js";
import { PageHeader } from "./PageHeader.js";
import { PageRelations } from "./PageRelations.js";
import { PageTOC } from "./PageTOC.js";

export function WikiPageDetail() {
  const { category, slug } = useParams({ from: "/wiki/$category/$slug" });
  const [mobileSheet, setMobileSheet] = useState<"toc" | "relations" | null>(null);
  const relPath = `wiki/${category}/${slug}.md`;
  const page = usePageDetail(relPath);

  if (page.isLoading) {
    return <div className="p-6 text-sm text-text-muted">Loading page...</div>;
  }
  if (page.error || !page.data) {
    return <div className="p-6 text-sm text-status-red">Page not found: {relPath}</div>;
  }

  const body = preprocessWikilinks(page.data.body, page.data.relations);
  const hasRelations = page.data.relations.length > 0 || page.data.inbound.length > 0;

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_240px]">
        <article className="max-w-3xl min-w-0">
          <PageHeader page={page.data} />
          <div className="mb-4 grid grid-cols-2 gap-2 md:hidden">
            <Button type="button" className="justify-center" onClick={() => setMobileSheet("toc")}>
              Outline
            </Button>
            <Button
              type="button"
              className="justify-center"
              disabled={!hasRelations}
              onClick={() => setMobileSheet("relations")}
            >
              Relations
            </Button>
          </div>
          <MarkdownBody source={body} />
          <PageRelations className="hidden md:block" inbound={page.data.inbound} relations={page.data.relations} />
        </article>
        <aside className="hidden md:block">
          <PageTOC body={page.data.body} />
        </aside>
      </div>
      <BottomSheet
        isOpen={mobileSheet !== null}
        onClose={() => setMobileSheet(null)}
        title={mobileSheet === "relations" ? "Relations" : "On this page"}
      >
        {mobileSheet === "relations" ? (
          <PageRelations className="mt-0" inbound={page.data.inbound} relations={page.data.relations} />
        ) : (
          <PageTOC body={page.data.body} />
        )}
      </BottomSheet>
    </div>
  );
}
