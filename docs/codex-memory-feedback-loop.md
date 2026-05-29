# Codex Implementation Brief — Close the Memory Feedback Loop (Phase 4.5)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The operator's complaint, verified 2026-05-28: **memories saved to Memory Fort never come back.** An agent (Claude) logs observations via the `memory` MCP `log_observation` tool, but nothing it records ever re-enters its context in a later session. Three breaks, all confirmed:

1. **`log_observation` writes are never committed.** Six observations logged this session landed in `raw/2026-05-28/manual-mcp-*.md` but were all `??` untracked — never committed, never synced to the VPS. The MCP write path has the same commit gap that Phase 4.3.S fixed for promote/reject, but 4.3.S didn't cover the MCP observation path.

2. **session-start injects only the curated index.** The session-start hook emits `schema.md + index.md + last 20 log.md lines`. `index.md` lists *curated wiki pages*. Logged observations live in the *raw* layer and only become curated via `compile` — which is stale (6 days) and prompt-only. So a fresh observation is invisible at session start until a human-driven compile promotes it into a page. Preferences and recent decisions never surface.

3. **`memory search` times out.** A `log_observation`/`search` round-trip via MCP timed out (the search runs BM25 + Voyage embeddings + rerank synchronously, ~10-16s, exceeding the MCP client timeout). Even deliberate recall is unreliable.

Net effect: Memory Fort is write-only from the agent's perspective. The operator's behavior-shaping preferences only persist because they're duplicated into the *host's* memory (Claude Code `MEMORY.md`), not because of Memory Fort. This brief makes Memory Fort actually feed back.

---

## Scope guard

You will:

### Task 1 — Commit observations on write

- The `memory` MCP `log_observation` handler (find it — likely `src/mcp/` or the claude-code-plugin MCP server entry, and the underlying writer in `src/hooks/` or `src/storage/`) must commit the raw file it writes, via the `commitVaultChange` helper from Phase 4.3.R/S
- Batch-friendly: if many observations are logged in quick succession, debounce or commit-per-write is acceptable — but the file must not be left untracked. Auto-push then syncs it (don't push per write)
- Confirm the **passive capture hooks** (session-end, post-tool-use) already commit (the `chore: auto-capture` commits suggest they do) — if any capture path leaves raw files untracked, fix it the same way
- Test: `log_observation` leaves a clean (committed) working tree for the new raw file

### Task 2 — Surface preferences + recent salient memory at session-start

- Extend the session-start context block (currently schema + index + log tail) to also inject a **"What you should remember"** section containing:
  - **Preferences / durable directives** — observations or curated pages tagged `preference` (or a dedicated `wiki/preferences.md` curated page if one is established). These are the behavior-shaping facts the agent must honor
  - **Recent high-confidence observations** — the last N (e.g., 10) raw observations with `confidence >= floor`, most-recent-first, so the agent sees what was recently learned even before compile curates it
- Keep the block bounded (token budget) — cap counts and truncate bodies. The existing `injectionConfidenceFloor()` is the right gate for quality
- This is the critical fix: it gives the agent its own recent memory at the start of every session, independent of whether compile has run
- Test: with preference-tagged + recent observations present, the session-start output includes them; with none, the block is omitted cleanly

### Task 3 — Fix the search timeout

- The MCP `search` tool times out on the synchronous BM25 + Voyage embed + rerank path. Options (pick the cleanest):
  - Raise the MCP tool's timeout / make the handler stream or return faster
  - Add a `no_rerank` fast path as the default for short queries (the tool already has a `no_rerank` param — consider defaulting it on for latency-sensitive recall, with rerank opt-in)
  - Cache the query embedding / warm the Voyage client
- Goal: a typical `memory search` returns within the MCP client timeout reliably. Document the expected latency
- Test: a search completes within a bounded time in the test harness (mock the embedder; assert the handler resolves without hanging)

### Task 4 — A durable preferences page

- Establish `wiki/preferences.md` as a curated, always-surfaced page (compile maintains it; session-start always injects it regardless of the index). Seed it from the existing preference-tagged observations (e.g., "always draft Codex prompts", "emit paths in code blocks", "use Memory Fort as the register"). This gives preferences a stable home that doesn't depend on the agent re-deriving them
- If a `preferences` concept already exists, extend it rather than duplicating
- Test: `wiki/preferences.md` is injected at session-start even if not referenced from index.md

### Task 5 — Docs

- `templates/schema.md`: document the feedback loop — observations commit on write, session-start surfaces preferences + recent salient memory, the preferences page
- `docs/ROADMAP.md`: Phase 4.5 shipped 2026-05-28 — closes the memory read-back loop

You will **not**:

- Inject the entire raw corpus at session-start. Bound it (preferences + last N high-confidence). Token budget matters
- Auto-push per observation. Commit-on-write; debounced auto-push propagates
- Change the host's Claude Code `MEMORY.md` mechanism. That's a separate, working channel; this brief makes Memory Fort's own loop work so the two aren't redundant
- Lower the confidence floor to surface noise. Quality gate stays
- Block `log_observation` on commit failure (best-effort + log, per 4.3.R/S)
- Rebuild search ranking. Just make it return within timeout (fast path / timeout / warm client)

If surfacing recent observations at session-start turns out to flood the context with low-signal capture noise (tool-call logs, etc.), **stop and ask** — we may need a salience filter (only observations tagged or above a higher confidence bar) rather than "last N".

---

## Repo orientation

- the `memory` MCP server entry + `log_observation` handler — find the writer; wire `commitVaultChange` (Phase 4.3.R/S, `src/sync/commit-vault-change.ts`)
- session-start hook: `~/.memory/claude-code-plugin/scripts/session-start.mjs` is the built artifact; the source is in `src/hooks/session-start.ts` (the comment "emit schema.md + index.md + last 20 log.md lines" marks the block to extend)
- `injectionConfidenceFloor()` — the existing quality gate to reuse
- search MCP handler — the `no_rerank` param already exists; the Voyage client init is in the dashboard/embedder code
- `src/cli/commands/verify/` — consider a `memory.feedback-loop` check (observations committed? preferences page present?) as a canary

---

## Acceptance contract

1. `log_observation` leaves a committed (clean) working tree; observations sync to the VPS without manual intervention
2. session-start output includes a bounded "what to remember" block: preference-tagged content + recent high-confidence observations
3. `wiki/preferences.md` is always surfaced at session-start
4. `memory search` returns within the MCP timeout reliably
5. Full suite passes (run ALL of it); typecheck clean; build + build:ui clean; `git diff --check` clean
6. Operator-verifiable: log an observation in one session, start a new session, and the agent's injected context reflects it (preference) or the recent-observations block shows it

---

## Verification commands

```powershell
cd C:\CodexProjects\memory-system
# Log an observation, confirm it commits
node dist/cli.mjs   # (or via MCP) log_observation
Push-Location "$env:USERPROFILE\.memory"; git status --porcelain raw/; Pop-Location   # should be clean

# Inspect what session-start would inject
node "$env:USERPROFILE\.memory\claude-code-plugin\scripts\session-start.mjs" < echo-empty-payload
# should include the preferences + recent-observations block

# Search returns promptly
Measure-Command { node dist/cli.mjs search "operator preferences" }   # bounded, no timeout
```

---

## Commit boundaries

- Task 1: `fix: commit observations on log_observation write (Phase 4.5 Task 1)`
- Task 2: `feat: surface preferences + recent memory at session-start (Phase 4.5 Task 2)`
- Task 3: `fix: memory search returns within MCP timeout (Phase 4.5 Task 3)`
- Task 4: `feat: durable wiki/preferences.md always surfaced (Phase 4.5 Task 4)`
- Task 5: `docs: memory feedback loop (Phase 4.5 Task 5)`

---

## Why this is the highest-value remaining work

Every other Phase 4.x feature improves what Memory Fort *stores*. This one is the first that makes what it stores *come back* — without it, the system is a write-only journal and the agent relies entirely on the host's separate memory. Closing this loop is what makes "use Memory Fort as my memory" actually true.

Depends on Phase 4.3.S (commit helper — shipped). Pairs with Phase 4.4 (compile-execute) which curates raw into pages; this brief covers the gap *before* compile runs by surfacing raw directly.
