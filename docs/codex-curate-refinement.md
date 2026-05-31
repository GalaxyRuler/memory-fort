# Codex Implementation Brief — Curate Refinement: Fact-Coverage Guard + Rewrite Steering + Prompt-Drift Fix (Phase 4.24)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Refines 4.23. Found by running 4.23 on the live vault — it hit the exact "stop and ask" the 4.23 brief predicted.

---

## What this is (observed live 2026-05-31)

4.23's `rewrite_page` mechanism works, but three things stop it from actually curating, plus a systemic bug that keeps invalidating verification.

1. **Shrinkage guard is length-based and blocks legitimate curation.** Live: the model emitted a `rewrite_page` for `memory-system.md`; the guard staged it as *"rewrite shrinks page - review for content loss."* But consolidating a bloated page **is supposed to shrink it**. A raw length-ratio guard blocks the exact operation we want. (4.23 brief flagged this as the stop-and-ask.)
2. **The model inconsistently chooses `rewrite_page`.** Same run: `iaqar.md` got an `appended` dated section and `agentmemory.md` a `write→append`, while only `memory-system` got a rewrite. So pages still accumulate append-sections while the curating rewrites get blocked → net bloat continues.
3. **`memory curate` path bug.** `memory curate agentmemory` → *"page not found: wiki/agentmemory"*. It doesn't resolve a bare page name to `wiki/<category>/<slug>.md`.
4. **Systemic: runtime-prompt drift (4th incident this session).** `runCompile` reads the prompt from the vault copy (`~/.memory/prompts/compile.md`), but prompt changes ship in the repo template (`templates/prompts/compile.md`). The vault copy goes stale, so prompt-dependent behavior (here, `rewrite_page`) silently doesn't happen. This invalidated 4.16, 4.19, 4.21, and 4.23 verification until manually re-synced. **This must be fixed permanently.**

---

## Scope guard

### Task 1 — Prompt-drift permanent fix (do this FIRST; it gates trustworthy testing)
- Add a `prompt.drift` verify check: compare each vault prompt under `~/.memory/prompts/` against the bundled template (`templates/prompts/`). If they differ AND the vault copy lacks a user-customization marker (e.g. a `# memory:custom` header line), **warn** with the remedy.
- Add `memory sync-prompts [--plan|--apply]` that copies bundled templates → vault prompts (skipping files with the custom marker). `memory init` already seeds them; this keeps them current.
- Make `runCompile` (and lint/page) **warn to stderr** when the vault prompt is missing a sentinel marker that the current template contains (cheap staleness signal at run time), pointing to `memory sync-prompts`.
- Decide (and implement) the default: prefer the **bundled template** unless a vault customization marker is present. This eliminates drift for the common (uncustomized) case. **Stop and ask if** you think preferring the vault copy is safer — but the 4 incidents argue for template-first.

### Task 2 — Fact-coverage guard, not length-ratio
- Replace the shrinkage length-ratio in the `rewrite_page` guard with a **fact-coverage** check: extract the prior page's salient anchors — `relations` targets, `[[wikilinks]]`, inline code paths/identifiers, and proper-noun/entity tokens — and verify the rewrite **retains ≥ threshold of them** (e.g. ≥90% of links/relations, ≥80% of entity tokens). A rewrite that is shorter but preserves the anchors **applies directly**; one that drops anchors **stages** for review.
- Keep the `wiki/.history/` archive on every applied rewrite (audit trail).
- This lets a bloated page legitimately shrink into a coherent article as long as the facts survive.

### Task 3 — Steer the model to `rewrite_page` for existing pages
- Strengthen `templates/prompts/compile.md`: for any entity that **already has a page**, the model MUST use `rewrite_page` (not `write_page`/`append_page`). `append_page` is ONLY for genuinely dated events; `write_page` ONLY for brand-new pages.
- Enforce in the executor as a backstop: if the model emits `write_page` or `append_page` for an existing knowledge page (not a dated-event append), and the page already has prose, **treat it as a rewrite candidate** (or stage with reason `"use rewrite_page for existing pages"`). Don't silently append.

### Task 4 — Fix `memory curate` path resolution
- Resolve a bare page argument (`agentmemory`, `iaqar`) to its actual path by searching `wiki/<category>/` for `<slug>.md`. Accept full relative paths too. Error only if no match across categories; if ambiguous (same slug in two categories), list the matches.

### Task 5 — Tests
- `prompt.drift` check: vault prompt differing from template (no custom marker) → warn; with marker → pass; `sync-prompts --apply` makes them match.
- Fact-coverage guard: a rewrite that shortens but keeps all links/relations → applies; one that drops a relation → stages. Archive written on apply.
- Steering: `write_page`/`append_page` against an existing prose page → rerouted to rewrite/stage, not blind append.
- `curate agentmemory` (bare name) → resolves `wiki/projects/agentmemory.md`.
- **Scale test (the one that matters):** simulate a hot entity across 20 passes with a CURRENT prompt → page stays coherent and bounded, rewrites apply, `.history` accumulates versions.

### Task 6 — Docs
- `docs/MEMORY-FORT-SPEC.md`: prompt-provenance model + fact-coverage guard.
- `docs/cli.md`: `memory sync-prompts`, fixed `memory curate`.
- `docs/ROADMAP.md`: Phase 4.24 shipped.

You will **not**:
- Apply a rewrite that drops salient anchors without staging (content-loss protection stays).
- Remove the `.history` archive.
- Break per-event `append_page` or new-page `write_page`.

---

## Acceptance contract
1. After `memory sync-prompts`, the `prompt.drift` check passes; a stale vault prompt is caught by verify, not by a failed drain.
2. A `rewrite_page` that consolidates a bloated page (shorter, all facts kept) **applies** and archives the prior version; one that loses a relation **stages**.
3. A 20-pass drain (current prompt) keeps a hot entity's page coherent and bounded; `.history` shows accumulated rewrites.
4. `memory curate <bare-name>` works.
5. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: prompt.drift verify + memory sync-prompts + template-first prompt (Phase 4.24 Task 1)`
- Task 2: `feat: fact-coverage rewrite guard replaces length-ratio (Phase 4.24 Task 2)`
- Task 3: `feat: steer + enforce rewrite_page for existing pages (Phase 4.24 Task 3)`
- Task 4: `fix: memory curate resolves bare page names (Phase 4.24 Task 4)`
- Task 5-6: `test+docs: curate refinement (Phase 4.24)`
