import type {
  DashboardStatus,
  LogTail,
  PageDetail,
  RawIndexEntry,
  RawSession,
  WikiIndex,
} from "./loaders.js";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nav(): string {
  return `<nav aria-label="Dashboard"><a href="/">Home</a><a href="/wiki/">Wiki</a><a href="/raw/">Raw</a><a href="/log">Log</a></nav>`;
}

function pageStart(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #242424; background: #f7f7f4; }
body { margin: 0; }
header, main, nav { max-width: 64rem; margin: 0 auto; padding: 1.5rem 2rem; }
nav { display: flex; gap: 1rem; padding-bottom: 0; }
nav a { color: #174d7c; text-decoration: none; font-weight: 600; }
nav a:hover { text-decoration: underline; }
header { border-bottom: 1px solid #ddd; }
h1 { margin: 0 0 .35rem; font-size: 2rem; }
h2 { margin: 0 0 1rem; font-size: 1.15rem; }
h3 { margin: 1rem 0 .5rem; font-size: 1rem; }
.meta { margin: 0; color: #666; }
section { padding: 1.25rem 0; border-bottom: 1px solid #e2e2de; }
dl { display: grid; grid-template-columns: minmax(9rem, 14rem) 1fr; gap: .55rem 1rem; margin: 0; }
dt { color: #666; }
dd { margin: 0; overflow-wrap: anywhere; }
ul { margin: .25rem 0 0; padding-left: 1.25rem; }
li { margin: .35rem 0; }
pre { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 1rem; overflow-x: auto; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
.banner { border-radius: 6px; padding: .85rem 1rem; margin-bottom: 1rem; }
.danger { background: #ffe8e7; color: #7a1712; border: 1px solid #efb1ac; }
.warn { background: #fff4cf; color: #644300; border: 1px solid #e6cb72; }
.ok { color: #176a2f; font-weight: 600; }
.page-list { list-style: none; padding-left: 0; }
.page-list li { padding: .65rem 0; border-top: 1px solid #e2e2de; }
.summary { color: #555; margin: .2rem 0; }
</style>
</head>
<body>
${nav()}`;
}

function pageEnd(): string {
  return `</body>
</html>`;
}

function wikiHref(relPath: string): string {
  const withoutExt = relPath.replace(/\.md$/, "");
  return `/wiki/${withoutExt.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function rawHref(date: string, filename: string): string {
  return `/raw/${encodeURIComponent(date)}/${encodeURIComponent(filename)}`;
}

function renderScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.join(", ");
  return "(unset)";
}

function renderSync(status: DashboardStatus): string {
  const sync = status.syncState;
  if (!sync) {
    return `<p>No sync state file found.</p>`;
  }

  const notices: string[] = [];
  if (sync.conflictsPending > 0) {
    notices.push(
      `<div class="banner danger"><strong>${sync.conflictsPending} files have unresolved sync conflicts.</strong> Run memory sync from a creator machine to resolve.<ul>${sync.conflictFiles
        .map((file) => `<li>${escapeHtml(file)}</li>`)
        .join("")}</ul></div>`,
    );
  }
  if (sync.pendingPushCount > 0) {
    notices.push(
      `<div class="banner warn">${sync.pendingPushCount} commits pending push (sync offline since ${escapeHtml(sync.lastSyncAttempt ?? "unknown")}).</div>`,
    );
  }

  return `${notices.join("")}<dl>
<dt>Last sync attempt</dt><dd>${escapeHtml(sync.lastSyncAttempt ?? "(none)")}</dd>
<dt>Last sync success</dt><dd>${escapeHtml(sync.lastSyncSuccess ?? "(none)")}</dd>
<dt>Pending push count</dt><dd>${sync.pendingPushCount}</dd>
<dt>Conflicts pending</dt><dd>${sync.conflictsPending}</dd>
</dl>`;
}

export function renderHomepage(status: DashboardStatus): string {
  const repo = status.repoHead;
  return `${pageStart("Memory dashboard")}
<header><h1>Memory dashboard</h1><p class="meta">Generated <time>${escapeHtml(status.generatedAt)}</time></p></header>
<main>
<section id="browse"><h2>Browse</h2><p><a href="/wiki/">Wiki pages</a> · <a href="/raw/">Raw sessions</a> · <a href="/log">Log tail</a></p></section>
<section id="sync"><h2>Sync</h2>${renderSync(status)}</section>
<section id="counts"><h2>Counts</h2><dl>
<dt>wikiPages</dt><dd>${status.counts.wikiPages}</dd>
<dt>rawObservations</dt><dd>${status.counts.rawObservations}</dd>
<dt>crystals</dt><dd>${status.counts.crystals}</dd>
</dl></section>
<section id="head"><h2>Repository</h2>${repo ? `<dl>
<dt>repoHead</dt><dd><code>${escapeHtml(repo.sha)}</code></dd>
<dt>Short SHA</dt><dd><code>${escapeHtml(repo.shortSha)}</code></dd>
<dt>Subject</dt><dd>${escapeHtml(repo.subject)}</dd>
<dt>Committed at</dt><dd>${escapeHtml(repo.committedAt)}</dd>
</dl>` : `<p>No commits found.</p>`}</section>
<section id="compile"><h2>Last compile</h2>${status.lastCompile ? `<dl>
<dt>Timestamp</dt><dd>${escapeHtml(status.lastCompile.timestamp)}</dd>
<dt>Line</dt><dd>${escapeHtml(status.lastCompile.line)}</dd>
</dl>` : `<p>No compile entry found.</p>`}</section>
<section id="errors"><h2>Errors log</h2><dl>
<dt>Status</dt><dd>${status.errorsLog.isClean ? `<span class="ok">clean</span>` : "has entries"}</dd>
<dt>Size</dt><dd>${status.errorsLog.sizeBytes} bytes</dd>
<dt>Last line</dt><dd>${escapeHtml(status.errorsLog.lastLine ?? "(none)")}</dd>
</dl></section>
</main>
${pageEnd()}`;
}

export function renderWikiIndex(index: WikiIndex): string {
  const categories = Object.keys(index.byCategory).sort();
  return `${pageStart("Wiki")}
<header><h1>Wiki</h1><p class="meta">${index.total} pages grouped by category.</p></header>
<main>
${categories
  .map(
    (category) => `<section><h2>${escapeHtml(category)}</h2><ul class="page-list">${index.byCategory[category]!
      .map(
        (entry) => `<li><a href="${wikiHref(entry.relPath)}">${escapeHtml(entry.title)}</a><p class="summary">${escapeHtml(entry.summary)}</p><p class="meta"><code>${escapeHtml(entry.relPath)}</code> · updated ${escapeHtml(entry.updated)}</p></li>`,
      )
      .join("")}</ul></section>`,
  )
  .join("")}
</main>
${pageEnd()}`;
}

export function renderWikiPage(page: PageDetail): string {
  const title = typeof page.frontmatter.title === "string" ? page.frontmatter.title : page.relPath;
  const category = page.relPath.split("/")[0] ?? "";
  const status = renderScalar(page.frontmatter.status ?? "active");
  const confidence = renderScalar(page.frontmatter.confidence);
  const tags = Array.isArray(page.frontmatter.tags) && page.frontmatter.tags.length > 0 ? page.frontmatter.tags.join(", ") : "(none)";

  return `${pageStart(title)}
<header><h1>${escapeHtml(title)}</h1><p class="meta"><code>${escapeHtml(page.relPath)}</code></p></header>
<main>
<section id="frontmatter"><h2>Metadata</h2><dl>
<dt>Category</dt><dd>${escapeHtml(category)}</dd>
<dt>Status</dt><dd>${escapeHtml(status)}</dd>
<dt>Confidence</dt><dd>${escapeHtml(confidence)}</dd>
<dt>Tags</dt><dd>${escapeHtml(tags)}</dd>
<dt>Updated</dt><dd>${escapeHtml(renderScalar(page.frontmatter.updated))}</dd>
</dl></section>
<section id="body"><h2>Body</h2><pre style="white-space: pre-wrap; font-family: inherit">${escapeHtml(page.body)}</pre></section>
<section id="relations"><h2>Relations</h2>${renderRelations(page.relations)}</section>
<section id="inbound"><h2>Inbound</h2>${renderInbound(page.inbound)}</section>
</main>
${pageEnd()}`;
}

function renderRelations(relations: PageDetail["relations"]): string {
  if (relations.length === 0) return "<p>(none)</p>";
  const grouped = new Map<string, PageDetail["relations"]>();
  for (const relation of relations) {
    const group = grouped.get(relation.key) ?? [];
    group.push(relation);
    grouped.set(relation.key, group);
  }

  return [...grouped.keys()]
    .sort()
    .map((key) => {
      const items = grouped.get(key)!;
      return `<h3>${escapeHtml(key)}</h3><ul>${items
        .map((relation) => {
          const target = relation.resolvedPath
            ? `<a href="${wikiHref(relation.resolvedPath)}">${escapeHtml(relation.resolvedTitle ?? relation.resolvedPath)}</a>`
            : `${escapeHtml(relation.target)} [unresolved]`;
          return `<li>${target} <span class="meta">target: ${escapeHtml(relation.target)}</span></li>`;
        })
        .join("")}</ul>`;
    })
    .join("");
}

function renderInbound(inbound: PageDetail["inbound"]): string {
  if (inbound.length === 0) return "<p>(none)</p>";
  return `<ul>${inbound
    .map(
      (ref) =>
        `<li><a href="${wikiHref(ref.fromPath)}">${escapeHtml(ref.fromTitle ?? ref.fromPath)}</a> <span class="meta">via ${escapeHtml(ref.via)}</span></li>`,
    )
    .join("")}</ul>`;
}

export function renderRawIndex(entries: RawIndexEntry[]): string {
  return `${pageStart("Raw sessions")}
<header><h1>Raw sessions</h1><p class="meta">${entries.length} date groups.</p></header>
<main>
${entries
  .map(
    (entry) => `<section><h2>${escapeHtml(entry.date)}</h2><ul>${entry.files
      .map(
        (file) => `<li><a href="${rawHref(entry.date, file.filename)}">${escapeHtml(file.filename)}</a> <span class="meta">${file.sizeBytes} bytes · ${escapeHtml(file.mtime)}</span></li>`,
      )
      .join("")}</ul></section>`,
  )
  .join("")}
</main>
${pageEnd()}`;
}

export function renderRawSession(session: RawSession): string {
  return `${pageStart(session.filename)}
<header><h1>${escapeHtml(session.filename)}</h1><p class="meta">${escapeHtml(session.date)} · ${session.sizeBytes} bytes</p></header>
<main><section><h2>Content</h2><pre style="white-space: pre-wrap; font-family: inherit">${escapeHtml(session.content)}</pre></section></main>
${pageEnd()}`;
}

export function renderLogTail(log: LogTail): string {
  const firstLineNumber = log.totalLines - log.lines.length + 1;
  const numbered = log.lines
    .map((line, index) => `${String(firstLineNumber + index).padStart(6, " ")}  ${line}`)
    .join("\n");
  return `${pageStart("Log tail")}
<header><h1>Log tail</h1><p class="meta">Showing last ${log.lines.length} of ${log.totalLines} lines, oldest first.</p></header>
<main><section><h2>Lines</h2><pre>${escapeHtml(numbered)}</pre></section></main>
${pageEnd()}`;
}

export function renderBadRequest(message: string): string {
  return `${pageStart("Bad Request")}
<main><h1>Bad Request</h1><p>${escapeHtml(message)}</p></main>
${pageEnd()}`;
}

export function renderNotFound(path: string): string {
  return `${pageStart("Not found")}
<main><h1>Not found</h1><p>No dashboard route matches <code>${escapeHtml(path)}</code>.</p></main>
${pageEnd()}`;
}
