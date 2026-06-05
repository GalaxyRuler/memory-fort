# Codex Prompt — Wire Raw-Capture Events into the Timeline

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Live vault**: `C:\Users\Admin\.memory`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`). Stop and ask if scope creeps past this prompt.

---

## Mission

`/api/timeline?zoom=1D` returns `0` events on the **claude-code**, **codex**, and **antigravity** lanes even though `/api/health` reports **233 claude-code + 335 codex + 2 antigravity captures today**. The 3 lanes are decorative: defined in `TIMELINE_LANES` but never populated. The Timeline view in the dashboard correctly says "I rarely see anything" because the loader pipeline doesn't produce events for those lanes.

This is a **code bug, not a data gap.** Raw captures exist on disk and in the embedding sidecar. They just never become `ActivityEvent`s.

Fix: add a `loadRawCaptureEvents` loader and route its output to the right lanes. Prove the fix by hitting the live API and counting events per lane against the on-disk raw files.

---

## Verified context (confirm by reading)

- **Lanes defined but unrouted.** `src/dashboard/loaders.ts:60` `TIMELINE_LANES` includes `"claude-code"`, `"codex"`, `"antigravity"`, `"manual"`, `"compile"`, `"lint"`, `"sync"`. The router at `loaders.ts:1323`:
  ```ts
  function timelineLaneForEvent(event: ActivityEvent): (typeof TIMELINE_LANES)[number] {
    if (event.source === "compile" || event.source === "lint" || event.source === "sync") return event.source;
    return "manual";
  }
  ```
  No path ever returns `"claude-code"`, `"codex"`, or `"antigravity"`.
- **Event sources.** `loadActivityEvents` (`loaders.ts:1074`) merges 4 loaders only: `loadGitActivityEvents` (source=`git`), `loadLogActivityEvents` (parsed from `log.md`), `loadCheckoutActivityEvents` (source=`sync`), `loadErrorActivityEvents` (source=`errors`). **None walk `raw/`.**
- **Captures land at** `~/.memory/raw/<YYYY-MM-DD>/<tool>-<session-id>.md`. Tool prefixes observed today: `claude-code-`, `claude-code-agent-`, `codex-`, `claude-desktop-`, `antigravity-` (rare), `manual-mcp-`. Each session-file is appended over time; mtime is the latest activity.
- **Health already counts captures correctly** via `wiki/.audit/.../capture-...` artifacts or by scanning raw/ — confirm where (`src/cli/commands/verify/sniffer-*.ts` likely path). The timeline must reuse the same scan, not invent a parallel one.
- **Live evidence the bug exists** (reproduced 2026-06-04):
  ```
  GET /api/timeline?zoom=1D
  -> lanes: claude-code 0, codex 0, antigravity 0, manual 101, compile 2, lint 0, sync 0
  GET /api/health (same minute) -> client.claude-code.capture: 233, client.codex.capture: 335
  ```

---

## Phase 1 — Audit (cite file:line)

1. Confirm the four current event sources by reading `loadActivityEvents` and its callers. Document each source's `source` value.
2. Locate the existing raw-capture scan used by the verify/health checks (sniffer paths). Treat it as the single source of truth for "how to enumerate captures".
3. Decide the **event granularity**: per session-file (one event per raw `.md`, timestamp = file mtime) vs per ToolUse block inside the file (one event per `## [TIMESTAMP] ToolUse: …` heading). Per-session-file is the right unit — much smaller, matches the existing capture-count metric, and avoids re-parsing every raw on every dashboard hit. Justify your choice.
4. Confirm `claude-desktop-*` and `claude-code-agent-*` filenames — should they bucket into the `claude-code` lane (subagents) or into their own lane? `claude-desktop` is its own client per `health` checks. **Add a `claude-desktop` lane** OR map it into `claude-code` — pick and justify.
5. Quantify the live damage: count raw `.md` files modified in the last 24h grouped by tool prefix. Show your method.

Output Phase 1 as a findings table.

---

## Phase 2 — Ground (online search, cite recency)

Search current practice for: timeline/activity feeds backed by file-system scans (mtime-based event derivation); efficient directory scans on cold cache (Windows quirks: `readdir` vs `glob` perf on 1000+ files); avoiding per-request re-parsing for dashboards with mtime caches. Distinguish fact from interpretation.

---

## Phase 3 — Options + trade-offs

Per problem, ≥ 2 viable options:

**A — Loader source**
- A1. **Walk `raw/<date>/`** and emit one event per `.md`. Cheap if scoped to recent N days. Use the runtime cache pattern (`SearchRuntimeCache` from `5b1aa08`) so we re-read only changed dirs.
- A2. **Walk the embedding sidecar** (`embeddings/raw.embeddings.jsonl`) for `path`/`ts` pairs. Free; piggybacks on the auto-heal pipeline. **Downside**: only captures that finished embedding appear; ones in the debounce queue don't (5–30s lag). Auto-heal can also be disabled.
- A3. **Subscribe to the capture watchdog signal** (`src/cli/commands/verify/sniffer-*.ts`). Reuses existing scan logic. Cleanest.

**B — Lane routing**
- B1. Map by filename prefix: `claude-code-*` / `claude-code-agent-*` → `claude-code`; `codex-*` → `codex`; `antigravity-*` → `antigravity`; `claude-desktop-*` → **add lane** `claude-desktop`.
- B2. Same as B1 but bucket `claude-desktop` into `claude-code`. Simpler UI, loses signal.

**C — Performance**
- C1. **Mtime-based cache**: scan once at server start + on each request only re-read directories whose mtime changed. Pair with the existing `SearchRuntimeCache`. The 5-min reconciler signal can invalidate too.
- C2. Recompute on every request. Simpler but the live `/api/timeline?zoom=1D` already takes time; with 1700+ raws this will add latency.

Recommend one per problem. **Conservatism**: don't regress `5b1aa08` (warm `refreshMs:0`, `rerankMs>0`); don't reintroduce request-path file-system stalls. Cache.

---

## Phase 4 — Implement (TDD, stay green)

- Tests first.
- Tests to add:
  - **`loadRawCaptureEvents`**: fixture vault with raw files across 4 tool prefixes → assert one event per file with correct `source` + timestamp = file mtime.
  - **`timelineLaneForEvent`**: assert claude-code/codex/antigravity/claude-desktop sources route to their lanes; manual / git / errors stay where they were.
  - **Cache invalidation**: change a single raw file's mtime → next call re-reads only that directory; no global rescan.
  - **API integration**: `GET /api/timeline?zoom=1D` against a seeded vault returns the expected lane counts.
  - **Velocity**: with raw events flowing, `velocity` buckets reflect real activity (regression vs. the current always-low line).
- Don't break: `5b1aa08` SearchRuntimeCache + warm search; `a41759c` auto-heal; `0566984` durability; `a60ebe2` write-guard; `bcf0c09` auto-link tuning; `340c5657`/`d675323a` graph-health pass.
- Keep `npm run typecheck`, `npm run build`, the suite green at every commit.

---

## Phase 5 — Adversarial self-audit (the gate)

Before claiming done, against the **live keyed dashboard** on the operator's vault:

1. **Before/after `/api/timeline?zoom=1D` lane counts**, side by side. Paste both responses' lane-count tables.
2. **Reconcile with `/api/health`**: capture counts per client should be in the same order of magnitude as the timeline event counts per lane for the same window. They don't have to be exact (granularity differs), but `claude-code` lane > 200 events when health reports 233 is the smell test.
3. **On-disk verification**: `ls C:\Users\Admin\.memory\raw\2026-06-04` grouped by tool prefix. The counts you produce must match the lane counts (within debounce lag).
4. **Velocity sanity**: chart no longer trends down to zero on an actively-captured day. Paste a sampled velocity bucket.
5. **Perf regression**: `/api/search` warm `refreshMs:0`, `rerankMs>0`, totalMs unchanged. Paste both before/after.
6. **Cache works**: hit `/api/timeline?zoom=1D` twice; second call must not re-read every raw directory. Show with a counter or timing.

A green unit test is not acceptance. Paste real commands + outputs. If a check can't be proven, say so and stop.

---

## Constraints

- Secrets env-var only; never print/commit `VOYAGE_API_KEY`; no secret-shaped content in logs.
- No permanent deletions; archive instead.
- No raw embedding spend.
- Windows + PowerShell 7. No OneDrive paths.
- Preserve all 8 source commits + 2 vault commits in the arc.

## Stop-and-ask

1. Choice between adding a `claude-desktop` lane vs. bucketing into `claude-code` is contentious — stop and propose, don't decide alone.
2. The capture-scan in verify/sniffer can't cleanly be reused (different shape) — stop before reimplementing.
3. Mtime-cache integration with `SearchRuntimeCache` requires changes to the cache module → that's a separate cross-cutting brief; stop.

## Output contract

- Phase 1 audit table (file:line citations + by-tool-prefix counts).
- Phase 2 sources + what you took.
- Phase 3 options + recommendation per problem.
- Diffs/commits + test names.
- **Phase 5 live evidence**: before/after `/api/timeline` JSON, on-disk counts, perf delta, cache-hit proof.
- Residual risks + updated operator runbook (none expected for the user — this is dashboard-side).

## Definition of done

- `/api/timeline?zoom=1D` populates **claude-code**, **codex**, **antigravity** (and `claude-desktop` if added) lanes with events that match the on-disk raw files within the same window.
- Event velocity line reflects real activity.
- All prior gains intact; suite + typecheck + build green.
- Every claim above backed by a live command output.
