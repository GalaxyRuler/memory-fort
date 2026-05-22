import type { DashboardStatus } from "./loaders.js";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Memory dashboard</title>
<style>
:root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #242424; background: #f7f7f4; }
body { margin: 0; }
header, main { max-width: 56rem; margin: 0 auto; padding: 2rem; }
header { border-bottom: 1px solid #ddd; }
h1 { margin: 0 0 .35rem; font-size: 2rem; }
h2 { margin: 0 0 1rem; font-size: 1.15rem; }
.meta { margin: 0; color: #666; }
section { padding: 1.25rem 0; border-bottom: 1px solid #e2e2de; }
dl { display: grid; grid-template-columns: minmax(9rem, 14rem) 1fr; gap: .55rem 1rem; margin: 0; }
dt { color: #666; }
dd { margin: 0; overflow-wrap: anywhere; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
.banner { border-radius: 6px; padding: .85rem 1rem; margin-bottom: 1rem; }
.danger { background: #ffe8e7; color: #7a1712; border: 1px solid #efb1ac; }
.warn { background: #fff4cf; color: #644300; border: 1px solid #e6cb72; }
.ok { color: #176a2f; font-weight: 600; }
</style>
</head>
<body>
<header><h1>Memory dashboard</h1><p class="meta">Generated <time>${escapeHtml(status.generatedAt)}</time></p></header>
<main>
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
</body>
</html>`;
}

export function renderNotFound(path: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Not found</title></head>
<body><main><h1>Not found</h1><p>No dashboard route matches <code>${escapeHtml(path)}</code>.</p></main></body>
</html>`;
}
