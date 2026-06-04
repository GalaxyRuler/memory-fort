# Codex Prompt — Fully-Functional Memory Fort: Auto-Heal + Service Supervisor

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system` (TypeScript ESM, `@galaxyruler/memory-system`)
**Live vault**: `C:\Users\Admin\.memory`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`). Stop and ask if scope creeps past this prompt.

---

## Mission

The retrieval stack is **functionally correct** today: durability fix (`0566984`), search-latency + reranker (`5b1aa08`). What's missing is **autonomy**. Two operator-friction points still keep the system from "just working":

1. **No auto-heal.** When new raw captures land (post-tool-use hook), or compile/backfill rewrite docs, their embeddings only get refreshed when the operator runs `memory provider reindex-embeddings --apply` by hand. The dashboard now deliberately skips request-time refresh (correct — no surprise spend), so stale docs sit until someone notices.
2. **Key fragility.** `VOYAGE_API_KEY` lives at Windows **User scope**, but long-running processes (dashboard, MCP server) only inherit it if launched from a shell that already has it. After a logout/reboot/key rotation, services come up keyless and the live vector path silently degrades. `embedding-health` now flags this (good), but nothing fixes it.

**Your job:** make Memory Fort hands-off. New captures embed automatically with bounded, predictable spend. Services come up keyed by themselves. The operator never asks "did I reindex?" or "why is search degraded?". Treat *verify-before-claim* as a hard rule — acceptance is **live evidence** (timings + log lines + restart drill), not "tests pass."

---

## Verified context (confirm by reading; do not trust)

- **Capture pipeline.** `src/hooks/post-tool-use.ts` and `src/hooks/raw-file.ts` write raw captures; `src/privacy/redaction.ts redactSecrets` runs at capture-time (since `571180a`). After redaction the file is final on disk — that is the right moment to embed.
- **Embed path.** `src/retrieval/refresh.ts refreshEmbeddings`: incremental, dim-guarded, saves successful batches incrementally, shares hash with `src/retrieval/embedding-text.ts`. The single embed primitive to reuse.
- **Write-guard intact.** Commit `a60ebe2` refuses to write any vector whose `dim !== config.embedding.dim`. Preserve it on every new write path.
- **Dashboard search.** `src/dashboard/server.ts` `/api/search`: no request-time refresh as of `5b1aa08`; `SearchRuntimeCache` (`src/retrieval/search.ts`) invalidates by file mtime/size. Auto-heal must not re-introduce request-path spend.
- **Health blind spots already closed.** `src/cli/commands/verify/embedding-health.ts` now fails when the active provider's key is missing from the process. Surface auto-heal status there too.
- **Voyage limits.** Free tier ≈ 300 RPM. Per-capture (one doc) is well under that; reconciler must rate-limit anyway.
- **No surprise spend.** This was the operator's hard line. Auto-heal must have a **daily-budget cap** in config, default-off, and emit a structured log line for every embed call.

---

## Phase 1 — Audit the capture→embed gap (read + cite)

Trace **capture → redact → save raw → (gap) → embed → save sidecar** and document where the auto-heal hook must attach. Specifically:

1. After a raw file is written + redacted, what (if anything) currently triggers embedding for that single new file? File:line.
2. Find every write path that produces an embedding-eligible document: raw hook, sniffer, compile/execute, backfill, curate, migrate, manual edits. Each one currently leaves embeddings stale until manual reindex. Inventory them.
3. Confirm the dashboard `/api/search` cache invalidates correctly when a new sidecar record lands mid-process (mtime/size signature), so an auto-heal write made by another process is picked up without a dashboard restart.
4. Confirm `embedding-health` currently flags missing-key and reaches operator-visible surfaces (CLI verify, dashboard `/api/health`).

Output as a findings table: `area | file:line | gap-or-ok | impact-on-autonomy`.

---

## Phase 2 — Ground with online search (cite, note recency)

Search current best practice for: (a) incremental/streaming embedding pipelines (capture-time vs background reconciler), (b) rate-limited token-budgeted embedding workers, (c) Windows service supervision via Task Scheduler and detached background processes for Node.js, (d) safe environment-variable propagation across user-scope and process-scope on Windows, (e) graceful degradation when an API key is absent. Distinguish fact from interpretation.

---

## Phase 3 — Propose options with trade-offs

For **each** problem, give **≥2 viable options** with explicit trade-offs (latency, spend, complexity, failure modes, reversibility). Likely directions — evaluate, don't assume:

### Problem A — Auto-heal

- **A1. Capture-time embed (single-doc fire-and-forget after redaction).** Lowest staleness. Slight added latency on the hook. Spend is one short call per captured raw. Must fail-soft (no key / 429 → log + skip; do **not** block capture, do **not** stub-write).
- **A2. Background reconciler (drain pending every N minutes while service up).** Catches anything A1 missed (compile rewrites, backfills, hook outages). Tick has a hard doc-cap and token-cap. Persists per-tick honest cost log.
- **A3. Both A1 + A2** (recommended for autonomy): capture-time for live freshness, reconciler as safety net.
- **A4. Scheduled cron via the existing scheduled-tasks system.** Simpler than a long-lived worker. Higher staleness window.

For whichever you pick, ALL of the following are non-negotiable:
- `auto_heal.enabled` config flag (default **off** — opt-in).
- `auto_heal.daily_budget_usd` (default **$0.50**); on overrun → log, skip remaining ticks until next UTC day.
- Reuse `refreshEmbeddings` as the embed primitive (so write-guard, incremental save, hash logic stay single-sourced).
- Every embed-call emits a structured JSON log line: `{ ts, source: "capture-time"|"reconciler", path, tokens, cost_usd, outcome }`.
- A dashboard `/api/auto-heal/status` (or a field on `/api/status`) reporting: enabled, last tick, last embed, daily spend, daily cap, next reset.

### Problem B — Service supervisor + key inheritance

- **B1. Launcher PowerShell script** (`scripts/start-memory-fort.ps1`): reads `VOYAGE_API_KEY` from User scope → frees port 4410 → spawns dashboard detached with the env injected → smoke-tests `/api/search` `degraded=false` before exiting (with a timeout). Idempotent.
- **B2. Windows Task Scheduler logon task** that invokes B1 → services come up keyed on every logon. Configured via `memory install supervisor --apply` (CLI wrapper around `schtasks.exe`). Idempotent install/uninstall.
- **B3. Auto-restart on key change.** Optional: a file-watcher on the User-scope env (or a "rotate-key" CLI) that kills + relaunches services. Justify if you include it; otherwise document the manual flow.
- **B4. MCP server inheritance.** The host app (Claude Code / Codex / Antigravity) spawns the MCP server. Document the host-restart drill *and* add a startup preflight in the MCP server that surfaces missing-key clearly (same path as `embedding-health`).

Recommend one per problem and justify.

---

## Phase 4 — Implement (TDD, stay green)

- **Tests first** for: capture-time embed fires on a new raw, fails-soft on no-key/429, respects daily budget; reconciler picks up missed docs, caps per tick, increments spend counter; launcher script idempotency (mock `schtasks`); preflight surfaces missing key.
- Reuse `refreshEmbeddings` — do not duplicate hash/embed/dim-guard logic.
- Keep `npm run typecheck`, `npm run build`, and the suite green at every commit. Don't break: `0566984` durability, `5b1aa08` perf, `a60ebe2` write-guard, dashboard cache, incremental cost, degraded-mode fast-fail.
- New CLI surfaces: `memory auto-heal status|enable|disable|tick`, `memory install supervisor --apply|--remove`, `memory supervisor status`.
- Config additions under `auto_heal:` with sane defaults and `memory init` migration.
- Small, reviewable commits with clear boundaries.

---

## Phase 5 — Adversarial self-audit (the "sure this time" gate)

Before claiming done, prove the system is hands-off by **live drills with real artifact reads** — not unit tests alone:

1. **Capture-time drill.** With `auto_heal.enabled=true` + a keyed dashboard: trigger a capture (write a tiny raw via the existing capture surface, NOT a fake fixture). Read `embeddings/raw.embeddings.jsonl` → assert a new record appeared with `dim=2048` within seconds, **without** running `provider reindex-embeddings`. Show the log line proving the embed was capture-time.
2. **Reconciler drill.** Stale a doc (touch its mtime so the cache invalidates but skip capture-time hook), wait one tick → assert it embedded. Confirm tick respects the doc-cap and the daily budget.
3. **Budget drill.** Set `daily_budget_usd: 0.001` and saturate it → assert subsequent ticks/captures log "skipped: daily budget reached" and do **not** call Voyage. Restore default.
4. **No-key drill.** Unset `VOYAGE_API_KEY` in the dashboard process → assert: (a) capture-time embed fails-soft with a clear log line, (b) `embedding-health` FAILs, (c) `/api/search` returns results in degraded mode (BM25 + graph), (d) **no `[1,0,0]` stub ever gets written** (write-guard intact). Re-key the process → next tick succeeds.
5. **Supervisor restart drill.** Kill the dashboard process → run the logon task (or the launcher script directly) → assert: port 4410 is listening within seconds, `degraded=false` on the smoke search, and `embedding-health` is `pass`. Paste the launcher's exit summary.
6. **Performance regression guard.** Re-run the warm `/api/search` timing: refreshMs ~0, rerankMs >0, totalMs ≪ 3s. Auto-heal must not have re-introduced request-path spend.

A green unit test is **not** acceptance for any of the six. Paste the actual command, the actual log/JSON output, and the artifact reads. If any drill cannot be proven, say so and stop.

---

## Constraints (hard)

- Secrets: env-var only. **Never** print or commit `VOYAGE_API_KEY`. No secret-shaped content in logs. The launcher must inject the key into the child process env **without** logging it.
- No permanent deletions; archive instead.
- No live full re-embed to "test." Use mocks/fixtures and the smallest possible real captures. Any spend > $0.05 in your drills → stop and ask.
- Windows + PowerShell 7. No OneDrive paths. Detached background processes via `Start-Process -WindowStyle Hidden` or `node --enable-source-maps … & disown` equivalent — document the chosen approach.
- Default `auto_heal.enabled=false`. Operator opts in deliberately. Default `daily_budget_usd=0.50`. Both surfaced in `memory init`.
- Do not regress: `5b1aa08` (warm refreshMs=0), rerankMs > 0, write-guard, incremental cost, degraded-mode fast-fail, dashboard cache invalidation.

## Stop-and-ask gates

1. Real Voyage spend in drills approaches $0.05.
2. Auto-heal design needs to touch the search request path (it must not — re-confirm if you think otherwise).
3. Supervisor needs admin/UAC elevation (a logon task should not — re-confirm).
4. MCP-server preflight requires changes to host-app integration beyond a clear error surface.

## Output contract

- Audit findings table (Phase 1) with file:line.
- Grounding sources + what you took from each (Phase 2).
- Options + recommendation with trade-offs (Phase 3).
- Diffs/commits + test names (Phase 4).
- **Live drill results** (Phase 5): each drill with command, real output, and artifact reads.
- Residual risks + an operator runbook covering: (a) enabling auto-heal, (b) setting/rotating the key, (c) installing the supervisor, (d) verifying autonomy.

## Definition of done ("fully functional")

- Capture-time embed: a new raw observation lands → its embedding appears in the sidecar within seconds, hands-off, with a log line proving capture-time.
- Reconciler drains stale within one tick, capped, budgeted, honest-cost-logged.
- Daily-budget overrun is loud and stops further spend without breaking capture or search.
- No-key state is loud (health + log), never silently degraded, never writes a stub.
- Logon task brings dashboard up keyed automatically; `degraded=false` on first query post-restart.
- All four prior gains intact: durability (`0566984`), perf (`5b1aa08`), write-guard (`a60ebe2`), incremental cost.
- Every claim above backed by a live drill output included in the report.
