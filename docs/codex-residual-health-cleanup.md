# Codex Implementation Brief — Residual Health Cleanup (Phase 4.32)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Three independent cleanups, commit each separately. No architectural change. The narrative-record model (4.31) and health-hardening (4.31.1) stay exactly as they are.

---

## Pre-flight (grounding, already done by Claude 2026-06-01)

- `frontmatter.source` already **passes** (all 41 live pages have provenance). **Do NOT touch source provenance — it is done.**
- `verify --offline --role server` exits 0, overall **warn**, 0 fail. Remaining warns: `dashboard.status` (offline skip — expected), `graph.cohesion` (density 0.06 — separate, out of scope), `curation.content-loss` (Task 1), plus graph sub-metrics.
- Build scripts already include `build:all` = `npm run build && npm run build:ui`.

---

## Task 1 — Clear `curation.content-loss` (17 pages)

### What the check actually measures
`src/cli/commands/verify/curation-content-loss.ts`: for each page with `.history`, it compares the **latest body** against the **previous `.history` version** and computes anchor coverage. It flags a page when **less than 80%** of any of these anchor sets from the previous version survive in the current body:
- `wikiLinks(body)` — `[[target]]` wikilinks (alias `|` stripped)
- `codeAnchors(body)` — backtick spans that look like paths/dotted identifiers (`/[\\/._-]/` or dotted-ident regex)
- `entityAnchors(body)` — (read the function for exact rule)

The 4.31 narrative migration flattened structured pages to prose and **dropped wikilinks + code-path backticks** that existed in the pre-migration version. That is the entire cause.

### The 17 flagged pages
```
wiki/decisions/2026-05-20-sidecar-embeddings-no-vector-db.md
wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md
wiki/decisions/2026-05-21-sentinel-marker-config-patches.md
wiki/decisions/2026-05-22-curation-orchestrator-not-llm.md
wiki/lessons/antigravity-mcp-only-ingestion.md
wiki/lessons/cross-platform-payload-field-fallback.md
wiki/lessons/engineering-process-lessons.md
wiki/lessons/js-yaml-date-auto-coercion.md
wiki/lessons/mcp-plugin-bundled-mcp-json.md
wiki/lessons/powershell-safe-vars.md
wiki/projects/agentmemory.md
wiki/projects/iaqar.md
wiki/projects/memory-system.md
wiki/references/agentmemory-consolidation-architecture.md
wiki/references/karpathy-llm-wiki-pattern.md
wiki/references/section-patch-fixture.md
wiki/tools/voyageai.md
```

### The fix (deterministic re-link, NOT an LLM rewrite)
This is a **mechanical anchor-restoration**, not a re-synthesis. For each flagged page:

1. Find the previous `.history` version (the one referenced by the page's `supersedes` frontmatter, or the newest file under `wiki/.history/<page-path>/`).
2. Compute the **dropped anchors** = `(wikiLinks ∪ codeAnchors ∪ entityAnchors)(previous)` minus the same sets on the current body.
3. For each dropped anchor, **re-introduce it into the current narrative prose** where it is contextually correct:
   - Dropped `[[wikilink]]` → find the plain-text mention of that entity in the current body and wrap it as a wikilink, OR append a short grounding sentence that references it (e.g. "This builds on [[agentmemory]]'s consolidation design.").
   - Dropped `` `code/path` `` → the current prose already names most paths in plain text; re-wrap them in backticks, OR add the path back where the sentence describes it.
4. Keep the body **narrative** — prose only, no `##` headings, no `-` bullet lists (do not regress the 4.31 invariant). Re-linking is inline: wrap existing words, or add at most 1–2 grounding sentences per page.
5. This is a **code-owned frontmatter** page: when you edit the body, bump `version`, append the prior file to `supersedes` (→ `wiki/.history/`), set `updated`/`last_accessed` to today — exactly as `synthesizeNarrative`'s wrapper does. Reuse that wrapper if practical; do not hand-roll a divergent frontmatter path.

### Build a helper command
Add `memory relink-anchors [--plan|--apply] [--page <slug>]`:
- `--plan` lists, per flagged page, the dropped anchors it would restore. Writes nothing.
- `--apply` performs the restoration + frontmatter bump + `.history` archive.
- Restrict to pages the content-loss check currently flags (compute the same coverage internally; do not blindly touch all pages).

If a dropped anchor has **no contextual home** in the current prose (the concept is genuinely gone, not just unlinked), **do not invent content** — list it under a `needs_review` section in the `--plan` output and skip it. Stop-and-ask if more than 3 anchors per page are unplaceable (means the migration lost real content and the page should be re-synthesized from facts, not re-linked).

### Acceptance (read the artifact + the check, lesson #2/#3)
- `memory verify --offline --role server --json` → `curation.content-loss` status is **pass** (or warns on ≤2 genuinely-unplaceable pages, each listed in `relink-anchors --plan` as `needs_review`).
- Read 3 of the repaired page **bytes**: assert the previously-dropped `[[wikilinks]]` are present, body still has **0** `^##` headings and **0** `^- ` list lines.
- `wiki/.history/` has a new archived version for each repaired page; each repaired page's `version` incremented.
- Full suite green.

**Commit:** `feat: relink-anchors command + restore 17 pages' dropped wikilinks/code anchors (Phase 4.32 Task 1)`

---

## Task 2 — Isolate `install-vscode.test.ts` flake to a temp dir

### Root cause (grounded)
`src/cli/commands/install/vscode.ts:75` returns `join(homedir(), ".vscode", "extensions")` as the extension dir. The test exercises the real install path, so it writes to the **real `~/.vscode/extensions/memory-fort.memory`**, then `rm(..., {recursive:true})` races against Windows file locks under parallel suite load → intermittent `ENOTEMPTY: rmdir '...\.vscode\extensions\memory-fort.memory'` (~1 in 4 full runs). The test already isolates the *workspace* path via `mkdtemp` and injects `homeDir`, but the **extensions dir is not injectable** — it always resolves to real `homedir()`.

### Fix
1. In `src/cli/commands/install/vscode.ts`: add an injectable `extensionsDir?: string` option (mirror the existing `homeDir` injection). Default stays `join(homeDir, ".vscode", "extensions")` so production behavior is unchanged.
2. In `test/cli/commands/install-vscode.test.ts`: pass `extensionsDir: join(tmp, "extensions")` for every test that triggers an extension write. No test should touch real `~/.vscode`.
3. Harden cleanup: the `afterEach` `rm(tmp, {recursive:true, force:true})` is fine once writes are inside `tmp`; if a Windows rmdir race still appears, add a small retry (`maxRetries`/`retryDelay` options on `rm`).
4. Check `connect.test.ts` for the same class (the report flagged it as likely same root cause) — apply the same injection if it writes to real `~/.vscode` or `~/.codex` / `~/.gemini`.

### Acceptance
- Run the **full suite** 20×; `install-vscode.test.ts` (and `connect.test.ts`) **0 failures**. (The flake only surfaces under full-suite load — do not validate by running the file alone.)
- Confirm no file is created under the real `~/.vscode` during the test run (e.g. snapshot that dir's mtime before/after, or assert the install result path is under `tmp`).
- Production install path unchanged: a real `memory install vscode` still targets `~/.vscode/extensions`.

**Commit:** `fix(test): isolate install-vscode/connect extension writes to temp dir (Phase 4.32 Task 2)`

---

## Task 3 — Stop `npm run build` leaving the dashboard unservable

### Root cause (grounded)
`npm run build` builds only the server bundle (tsdown); it does not build `dist/dashboard-ui/`. Worse, it clears/omits that dir, so a following `memory dashboard` throws `ENOENT: ...dist\dashboard-ui\index.html ... run npm run build:ui first`. `build:all` exists but nothing makes `build` or `dashboard` use it. Bitten twice on fresh/cleaned trees.

### Fix (pick the cleaner; prefer A)
**A — `memory dashboard` self-heals.** In `src/cli/commands/dashboard.ts`, before the existing `existsSync(indexHtml)` throw: if `index.html` is missing AND we are running from source/dev (not a packaged install), run the UI build (`vite build` via the same mechanism `build:ui` uses) and log `building dashboard UI (dist/dashboard-ui missing)…`, then proceed. If the build fails, fall back to the current clear error. Do not auto-build on every start — only when `index.html` is absent.

**B — make `build` complete.** Change `build` to also build the UI (or alias the docs/CI to `build:all`). Risk: tsdown's clean step may wipe `dist/dashboard-ui` if it runs after `build:ui` — if you take B, ensure `build:ui` runs **last** and tsdown's clean does not delete `dashboard-ui` (configure tsdown `clean` to exclude it, or build UI into a path tsdown won't clear).

Prefer **A** — it fixes the actual user-facing failure regardless of which build command was run, and can't be defeated by clean-order ordering.

### Acceptance
- From a tree where `dist/dashboard-ui/` is absent (delete it to simulate), run **only** `node dist/cli.mjs dashboard --no-open` → it serves **200** on `/memory/api/status` without a manual `build:ui`, logging that it built the UI.
- A normal start (dist present) does **not** rebuild — confirm no rebuild log line and fast startup.
- Full suite green; `dashboard.test.ts` covers the auto-build-when-missing path with a mocked builder (don't run a real vite build inside the unit test).

**Commit:** `fix(dashboard): auto-build UI when dist/dashboard-ui missing (Phase 4.32 Task 3)`

---

## You will NOT
- Re-introduce `##` headings or `-` bullet lists into any knowledge-page body (4.31 narrative invariant holds).
- Touch source provenance (already passing) or the graph-cohesion density metric (separate work).
- Invent page content to satisfy the anchor check — unplaceable anchors go to `needs_review`, not fabricated prose.
- Change production install targets (`~/.vscode` stays real in production; only tests inject temp dirs).
- Auto-build the UI on every dashboard start — only when `index.html` is missing.
- Claim done on exit code or check status alone — read repaired page bytes (Task 1) and run the full suite 20× (Task 2).

## Stop and ask
1. A content-loss page has >3 unplaceable dropped anchors → the migration lost real content; flag for re-synthesis, don't fake links.
2. `connect.test.ts` writes to a real client dir other than `~/.vscode` (`~/.codex`, `~/.gemini`) → confirm before redirecting, those may be intentional integration checks.
3. Taking build-fix option B and tsdown clean-order can't be made safe → fall back to A.

## Final verification (all three landed)
- `memory verify --offline --role server` → 0 fail; `curation.content-loss` pass (or ≤2 documented `needs_review`).
- Full suite 20× → 0 flakes from vscode/connect.
- `rm -rf dist/dashboard-ui && memory dashboard --no-open` → 200.
- `npm run typecheck`, `npm run build`, `npm run build:ui` all clean.
- One commit per task (3 total).
