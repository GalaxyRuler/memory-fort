# Phase 4 Checkpoint

## Dogfood — Route-by-Route

`/memory/` returned HTTP 200 with `text/html; charset=utf-8`, and the SPA shell loaded on desktop and mobile. The client-rendered content area showed `Not Found` instead of the overview stat cards, which appears to be a production basepath/router mismatch under the `/memory` mount.

`/memory/search?q=voyage` returned HTTP 200 with the SPA HTML shell. The page rendered the shared shell and search affordance, but the content area showed `Not Found`; no search input/results screen was reachable through the live mounted route.

`/memory/wiki` returned HTTP 200 with the SPA HTML shell. The page rendered the shell but showed `Not Found`, so the wiki browse cards could not be dogfooded live through the production prefix.

`/memory/wiki/decisions/2026-05-20-voyage-ai-for-embeddings` returned HTTP 200 with the SPA HTML shell. The breadcrumb/deepest segment reflected the route, but the content showed `Not Found`; the markdown body, relations, and TOC were not reachable on the live prefixed route.

`/memory/raw` returned HTTP 200 with the SPA HTML shell. The shell loaded, but the raw chronological list did not render because the content area showed `Not Found`.

`/memory/raw/2026-05-24/codex-019e523a-ac07-79f1-848d-e86c6006d223.md` returned HTTP 200 with the SPA HTML shell. The route loaded the shell and deepest segment, but rendered `Not Found` instead of the raw session detail.

`/memory/graph` returned HTTP 200 with the SPA HTML shell. The graph route did not reach the lazy 3D graph or mobile fallback; it rendered `Not Found`, so no WebGL frame could be assessed.

`/memory/timeline` returned HTTP 200 with the SPA HTML shell. The SVG timeline view did not render; the content area showed `Not Found`.

`/memory/activity` returned HTTP 200 with the SPA HTML shell. The activity feed did not render; the content area showed `Not Found`.

`/memory/sessions` returned HTTP 200 with the SPA HTML shell. The sessions tile grid did not render; the content area showed `Not Found`.

`/memory/crystals` returned HTTP 200 with the SPA HTML shell. The crystals empty/list state did not render; the content area showed `Not Found`.

`/memory/audit` returned HTTP 200 with the SPA HTML shell. The audit log did not render; the content area showed `Not Found`.

`/memory/settings` returned HTTP 200 with the SPA HTML shell. The read-only config sections did not render; the content area showed `Not Found`.

`/memory/compile` returned HTTP 200 with the SPA HTML shell. The compile read-only screen did not render; the content area showed `Not Found`.

`/memory/conflicts` returned HTTP 200 with the SPA HTML shell. The conflict-resolution read-only screen did not render; the content area showed `Not Found`.

`/memory/maintenance` returned HTTP 200 with the SPA HTML shell. The maintenance screen did not render; the content area showed `Not Found`.

## Screenshots

Desktop screenshots were captured with the available native viewport, `3440x1440`. Mobile screenshots were captured at `390x844`. Every screenshot currently demonstrates the same production basepath bug: shell chrome renders, but route content shows `Not Found`.

| Route | Desktop | Mobile |
| --- | --- | --- |
| index | [desktop](phase-4-screenshots/desktop/index.png) | [mobile](phase-4-screenshots/mobile/index.png) |
| search | [desktop](phase-4-screenshots/desktop/search.png) | [mobile](phase-4-screenshots/mobile/search.png) |
| wiki | [desktop](phase-4-screenshots/desktop/wiki.png) | [mobile](phase-4-screenshots/mobile/wiki.png) |
| wiki-detail | [desktop](phase-4-screenshots/desktop/wiki-detail.png) | [mobile](phase-4-screenshots/mobile/wiki-detail.png) |
| raw | [desktop](phase-4-screenshots/desktop/raw.png) | [mobile](phase-4-screenshots/mobile/raw.png) |
| raw-detail | [desktop](phase-4-screenshots/desktop/raw-detail.png) | [mobile](phase-4-screenshots/mobile/raw-detail.png) |
| graph | [desktop](phase-4-screenshots/desktop/graph.png) | [mobile](phase-4-screenshots/mobile/graph.png) |
| timeline | [desktop](phase-4-screenshots/desktop/timeline.png) | [mobile](phase-4-screenshots/mobile/timeline.png) |
| activity | [desktop](phase-4-screenshots/desktop/activity.png) | [mobile](phase-4-screenshots/mobile/activity.png) |
| sessions | [desktop](phase-4-screenshots/desktop/sessions.png) | [mobile](phase-4-screenshots/mobile/sessions.png) |
| crystals | [desktop](phase-4-screenshots/desktop/crystals.png) | [mobile](phase-4-screenshots/mobile/crystals.png) |
| audit | [desktop](phase-4-screenshots/desktop/audit.png) | [mobile](phase-4-screenshots/mobile/audit.png) |
| settings | [desktop](phase-4-screenshots/desktop/settings.png) | [mobile](phase-4-screenshots/mobile/settings.png) |
| compile | [desktop](phase-4-screenshots/desktop/compile.png) | [mobile](phase-4-screenshots/mobile/compile.png) |
| conflicts | [desktop](phase-4-screenshots/desktop/conflicts.png) | [mobile](phase-4-screenshots/mobile/conflicts.png) |
| maintenance | [desktop](phase-4-screenshots/desktop/maintenance.png) | [mobile](phase-4-screenshots/mobile/maintenance.png) |

## Latency

Overview load latency: cold-cache unmeasured: live `/memory/` renders `Not Found` before overview stat cards appear. Warm-cache unmeasured for the same reason.

Search latency: cold-cache unmeasured: live `/memory/search?q=voyage` renders `Not Found`, so keystroke-to-results timing is not meaningful. Warm-cache unmeasured for the same reason. The backend CLI search for `voyage` completed with 10 results in 26257ms, but that is not a UI render latency.

Graph load latency: cold-cache unmeasured: live `/memory/graph` renders `Not Found`, so no first 3D canvas frame is produced. Warm-cache unmeasured for the same reason.

## Bundle

`npm run build:ui` output:

```text
../../dist/dashboard-ui/index.html                           0.50 kB │ gzip:   0.30 kB
../../dist/dashboard-ui/assets/index-C8jEfmBa.css           45.36 kB │ gzip:   8.24 kB
../../dist/dashboard-ui/assets/GraphPage-cW20dMVJ.js        26.80 kB │ gzip:   8.60 kB │ map:    87.23 kB
../../dist/dashboard-ui/assets/markdown-BTbUDmij.js        166.07 kB │ gzip:  50.76 kB │ map:   987.35 kB
../../dist/dashboard-ui/assets/index-wrCAJHhA.js           504.55 kB │ gzip: 150.64 kB │ map: 2,124.84 kB
../../dist/dashboard-ui/assets/graph-engine-Dc8PQdfH.js  1,342.21 kB │ gzip: 362.71 kB │ map: 6,829.81 kB
```

Compared to the Slice 17 reference, main is unchanged at 504.55 KB / 150.64 KB gzip, GraphPage is unchanged at 26.80 KB / 8.60 KB gzip, and graph-engine is unchanged at 1342.21 KB / 362.71 KB gzip. No chunk moved by more than 5 KB raw.

## CLI Search

Command path verified with `npm run` and `npm run memory -- --help`; the actual invocation was `npm run memory -- search "voyage"`. It returned 10 results; the first result path was `wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md`.

First 10 captured output lines:

```text
> @galaxyruler/memory-system@0.1.0 memory
> node dist/cli.mjs search voyage

Query: voyage
Found 10 results in 26257ms (degraded: no)
1. wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md [score=0.69140625 source=rerank]
   [[memory-system]] uses Voyage AI for both embeddings (voyage-4-large, 2048-dim) and reranking (rerank-2.5) over alternatives like OpenAI text-embedding-3, Cohere, or local Ollama models.
2. wiki/tools/voyageai.md [score=0.6875 source=rerank]
   Official TypeScript SDK for Voyage AI's embedding and rerank APIs. Used by [[memory-system]] Phase 3 retrieval (`src/retrieval/voyage-client.ts`).
3. raw/2026-05-22/codex-019e4bf7-d7b8-7150-a65e-c21631ba25b6.md [score=0.57421875 source=rerank]
```

## MCP Search

MCP search was run from this Codex session using the installed `memory.search` tool with query `voyage`, `k=2`, `scope=all`. It returned 2 results in 3066ms total, degraded false.

First result:

```json
{
  "rank": 1,
  "path": "wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md",
  "title": "Voyage AI for embeddings and reranking",
  "score": 0.69140625,
  "source": "rerank",
  "kind": "wiki"
}
```

Second result:

```json
{
  "rank": 2,
  "path": "wiki/tools/voyageai.md",
  "title": "voyageai npm SDK",
  "score": 0.6875,
  "source": "rerank",
  "kind": "wiki"
}
```

## Tailscale-Only

From the VPS itself, `curl -sS -D - -o /tmp/memory-root.html http://127.0.0.1:4410/memory/` returned HTTP 200 with `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-cache`; the body began with `<!doctype html>`.

From this session I could not easily run a non-Tailscale shell probe. I did not silently skip it: public non-Tailscale verification remains unmeasured because the available terminal is on the tailnet path.

## Open Follow-Ups

- Production SPA basepath bug: live `/memory/*` routes serve HTML successfully, but the client router renders `Not Found` for every route. This blocks all route dogfood and gates the v0.4.0-phase4 tag.
- `BottomSheet` has two elements with `aria-label="Close bottom sheet"` redundancy from Slice 16; consolidate the labels.
- `useListKeyNav` currently mixes `role="listitem"` with `aria-selected`; switch to listbox/option semantics or drop `aria-selected`.
- `install-vps` scp fallback now performs a remote `rm -rf` before upload, so stale dashboard assets are cleared, but native rsync is still absent on this Windows host. Consider WSL rsync, cwrsync, or making the fallback an explicitly documented deployment path.
- `smoke-marker.md` exists in the wiki root from earlier phase testing and should be removed or formally documented.
- `npm audit` has 4 moderate vulnerabilities from `react-force-graph-3d` transitives; keep tracking upstream or plan mitigation.
- F17 raw embedding refresh token cap polish is still open.
- Mobile WebGL graph decision remains open: add `react-force-graph-2d` or keep the permanent list fallback.
- `/raw` design alignment to the iteration-3 mock remains open: transcript-preview versus session-browser should be either deferred deliberately or revisited.
- Non-Tailscale public probe was not completed from this environment; verify from a true non-tailnet network before tagging.

## Ready to Tag

Are we ready to tag v0.4.0-phase4? No.

Reason: the live VPS serves the SPA shell and assets, but every `/memory/*` client route currently renders `Not Found` under the production prefix. The tag should wait until the TanStack Router basepath or deployment mount handling is corrected and the primary screens can be dogfooded against the real corpus.
