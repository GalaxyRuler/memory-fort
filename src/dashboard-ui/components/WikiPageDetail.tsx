import { useParams } from "@tanstack/react-router";
import { usePageDetail } from "../hooks/usePageDetail.js";
import { preprocessWikilinks } from "../lib/wikilinks.js";
import { MarkdownBody } from "./MarkdownBody.js";
import { PageHeader } from "./PageHeader.js";
import { PageRelations } from "./PageRelations.js";
import { PageTOC } from "./PageTOC.js";

export function WikiPageDetail() {
  const { category, slug } = useParams({ from: "/wiki/$category/$slug" });
  const relPath = `wiki/${category}/${slug}.md`;
  const page = usePageDetail(relPath);

  if (page.isLoading) {
    return <div className="p-6 text-sm text-text-muted">Loading page...</div>;
  }
  if (page.error || !page.data) {
    return <div className="p-6 text-sm text-status-red">Page not found: {relPath}</div>;
  }

  const body = preprocessWikilinks(page.data.body, page.data.relations);

  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_240px]">
        <article className="max-w-3xl">
          <PageHeader page={page.data} />
          <MarkdownBody source={body} />
          <PageRelations inbound={page.data.inbound} relations={page.data.relations} />
        </article>
        <aside className="hidden md:block">
          <PageTOC body={page.data.body} />
        </aside>
      </div>
    </div>
  );
}
