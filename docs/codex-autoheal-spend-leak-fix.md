# Codex Prompt — Auto-Heal Spend Leak: Duplicate Embeds, EBUSY Race, Status Drift

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Live vault**: `C:\Users\Admin\.memory`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`). Stop and ask if scope creeps past this prompt.

---

## Mission

Auto-heal works (commit `a41759c`) — 66 docs embedded hands-off today. But reading `~/.memory/embeddings/auto-heal.jsonl` (76 entries, today's UTC window 05:14–08:15) reveals it is **leaking ~40 % of its real spend** on three bugs:

1. **Duplicate capture-time embeds of the same growing raw file.** A single session-raw was embedded **3 times in 14 seconds**, each as a real Voyage call. Hook fires per tool-use; every append flips the sha256; refresh sees "pending" and pays again.
2. **EBUSY race on the `.prev` backup copy** during sidecar write — 12 of 76 entries (~16 %) `outcome:"failed"` with `EBUSY: resource busy or locked, copyfile '…/raw.embeddings.jsonl' -> '…/raw.embeddings.jsonl.prev'`. Voyage tokens are paid before the local write, so a failed write is wasted spend.
3. **Status counter ≠ log sum.** `memory auto-heal status` reports `dailySpendUsd: 0.0793` and `/api/auto-heal/status` agrees, but summing `cost_usd` across today's log yields **`0.1329`** — `$0.054` unaccounted. Either status undercounts (so the daily cap is wrong upward) or the log overcounts (so reporting is theatre). One source of truth.

At today's measured rate (~$0.05 wasted / 3 hr while idle-ish), this is ≥ $0.40/day wasted under normal load — and **could mask the daily-budget cap**, the exact safety net we shipped. Operator burned three times before by "fixed" claims that didn't hold up to artifact reads. Acceptance is **re-reading `auto-heal.jsonl`** after the fix and seeing dup-rate ≈ 0, failed ≈ 0, status == log sum — not a green test.

---

## Evidence (verified 2026-06-04, by reading `~/.memory/embeddings/auto-heal.jsonl`)

Three real log entries for path `raw/2026-06-04/codex-019e910e-65c6-7a42-ace6-5cd5bfdeceba.md`:

```jsonl
{"ts":"2026-06-04T05:15:21.150Z","source":"capture-time","path":"raw/2026-06-04/codex-019e910e-65c6-7a42-ace6-5cd5bfdeceba.md","tokens":8733,"cost_usd":0,"outcome":"failed","reason":"EBUSY: resource busy or locked, copyfile 'C:\\Users\\Admin\\.memory\\embeddings\\raw.embeddings.jsonl' -> 'C:\\Users\\Admin\\.memory\\embeddings\\raw.embeddings.jsonl.prev'"}
{"ts":"2026-06-04T05:15:21.374Z","source":"capture-time","path":"…codex-019e910e…","tokens":10114,"cost_usd":0.00121368,"outcome":"embedded"}
{"ts":"2026-06-04T05:15:21.431Z","source":"capture-time","path":"…codex-019e910e…","tokens":10114,"cost_usd":0.00121368,"outcome":"embedded"}
{"ts":"2026-06-04T05:15:34.425Z","source":"capture-time","path":"…codex-019e910e…","tokens":9195,"cost_usd":0,"outcome":"failed","reason":"EBUSY: …copyfile…"}
{"ts":"2026-06-04T05:15:34.701Z","source":"capture-time","path":"…codex-019e910e…","tokens":10870,"cost_usd":0.00121368+ε,"outcome":"embedded"}
```

Counts across all 76 entries: **embedded 62 · failed 12 · skipped 2 · capture-time 69 · reconciler 7 · log sum $0.1329 · status $0.0793**. Reproduce these numbers from the file before you start; cite them in your report.

---

## Phase 1 — Root-cause (read the code; cite file:line)

For **each** bug, pin the cause precisely and cite. Don't propose fixes until causes are pinned.

### Bug 1 — duplicate same-file embeds within seconds

Likely chain: `src/hooks/post-tool-use.ts` calls `runAutoHealCapture` after every tool-use; each tool-use **appends** to the same session-raw file (e.g. `raw/2026-06-04/codex-<session>.md`); each append changes bytes → `hashEmbeddingBody` differs from the stored hash → `refreshEmbeddings` marks the doc pending → embed pays Voyage. The capture-time path therefore re-embeds the **same growing file** N times per session. Confirm in `src/hooks/post-tool-use.ts`, `src/retrieval/auto-heal.ts runAutoHealCapture`, and `src/retrieval/refresh.ts` (single-doc `pending` selection). Quantify N (embeds per unique session-raw) over today's log.

### Bug 2 — EBUSY on `.prev` backup

Find where the `.prev` copy happens (likely `src/retrieval/embeddings-store.ts saveEmbeddings`/`assertEmbeddingsWritable` or an atomic-write helper). Identify which writer holds the file open when the copy fires: (a) `SearchRuntimeCache` mtime-checked re-read in `src/retrieval/search.ts`, (b) a concurrent capture-time call for a different raw, (c) the scheduler reconciler tick, (d) Windows AV/Defender scanning newly-written file. Confirm the read-lock interplay on Windows (file-share defaults differ from POSIX). State which it is, not which it might be.

### Bug 3 — status counter ≠ log sum

`runAutoHealCapture`/`runAutoHealTick` returns a `RefreshResult`; persisted status is updated from that. The log is written per-entry inside the same path. Find where the two diverge. Candidates: status only adds `result.refresh.embedded` cost on the *outer* success path while the log records each retried/duplicate attempt independently; or persisted status is read with day-rollover logic that drops entries from a prior write; or the dashboard scheduler and CLI tick use separate counters. Pin which.

Output Phase 1 as a table: `bug | file:line | cause | evidence (log line / code path) | impact`.

---

## Phase 2 — Ground (online search, cite recency)

Search current best practice for: capture-time embedding pipelines vs. **debounced/queued** per-session embedding; atomic file replace on Windows (POSIX `rename` vs. `MoveFileEx` vs. copy-and-replace; sharing modes; AV interference); single source of truth for cost accounting (log-derived vs. counter-derived). Distinguish fact from interpretation; note dates.

---

## Phase 3 — Options + trade-offs

Give ≥ 2 viable options per bug with trade-offs (latency, money, complexity, failure modes). Likely directions (evaluate, don't assume):

**Bug 1 — duplicate embeds**

- **Debounce per session-raw.** After each tool-use, schedule (or extend) a per-path timer; the actual embed fires once after N seconds of quiet (e.g. 30 s, configurable as `auto_heal.capture_debounce_seconds`). The reconciler is the backstop for files whose session never quiets.
- **Idempotency check before paying.** Compute hash → if it equals the last embed's input hash for that path **within the same tick interval**, skip. Lighter, but still pays once per tool-use if appends are slow.
- **Defer capture-time to reconciler entirely.** Simpler, higher staleness window (one tick, default 5 min). Operator might prefer fresher.

Recommend **debounce** (default 30 s) + reconciler backstop. Keep capture-time freshness; kill the N-per-session waste.

**Bug 2 — EBUSY race**

- **Drop the `.prev` backup.** Write-time dim guard (`a60ebe2`) + temp-file + atomic `rename` already protect against corruption. The `.prev` is belt-and-suspenders the operator never relied on. Justify removal in the report.
- **Keep `.prev`, replace `copyfile` with `fs.rename` to a `.prev` name then `rename` the new file in.** Single inode dance, no concurrent read-lock window. May still race on Windows when AV holds the file; document.
- **Serialize sidecar writes with an in-process async mutex** per (memoryRoot, kind). Cheap; removes EBUSY when the contention is intra-process.

Recommend **mutex + drop `.prev`** (or convert it to a once-per-day archive snapshot taken when the file is known idle). Cleanest, cheapest, no Windows lock dance.

**Bug 3 — status drift**

- **Derive status from the log.** `auto-heal status` reads `auto-heal.jsonl`, filters today's UTC window, sums `cost_usd` of `outcome:"embedded"`. One source of truth; the counter file becomes a cache (or is removed).
- **Reconcile the counter on every write.** Keeps the counter, but reads the log on update to repair drift.

Recommend **derive from log**. The counter is the bug surface; the log is already the ground truth.

---

## Phase 4 — Implement (TDD, stay green)

- Tests first. Keep `npm run typecheck`, `npm run build`, the suite green at every commit.
- New tests:
  - Capture-time debounce: 5 tool-uses on the same session-raw within the window → **exactly one** embed call to the embedder mock; the embedded text reflects the **final** body.
  - Concurrent captures on different raws → no EBUSY; both embeds land; sidecar contains both records; mutex serializes.
  - Status-from-log: synthesize a known `auto-heal.jsonl` (mix of embedded/failed/skipped, with two days), assert `auto-heal status` returns the exact sum of today's `embedded` `cost_usd` entries.
  - Preserve daily budget: simulate spend that exceeds the cap → next capture/tick logs `skipped: daily budget reached`, no Voyage call. Use the log-derived spend.
- Don't break: `0566984` durability, `5b1aa08` perf, `a41759c` launcher, `a97110d` supervisor, write-guard `a60ebe2`, dashboard `SearchRuntimeCache`, MCP server.

---

## Phase 5 — Adversarial self-audit (the gate: read `auto-heal.jsonl`)

Before claiming done, prove by re-reading the log against the running, keyed dashboard — not unit tests alone. Use the **live vault** (auto-heal already on), let it run a few minutes of real captures, then paste:

1. **No same-path dup embeds within N seconds:** for the last 100 log entries, **max embeds per (path, hour)** must be ≤ 1 in steady state, and `> 1` only across debounce windows. Show the exact counts before/after the fix.
2. **EBUSY count ≈ 0:** in the post-fix window, `outcome:"failed"` with `EBUSY` is zero (or document a residual cause that's not in our control, e.g. AV).
3. **Status == log:** `memory auto-heal status` `dailySpendUsd` equals the summed `cost_usd` of today's `embedded` entries in `auto-heal.jsonl`. Paste both numbers.
4. **Performance regression guard:** warm `/api/search` still `refreshMs:0`, `rerankMs:>0`, fast totals. Auto-heal must not have re-introduced query-path cost.
5. **Budget gate intact:** force `daily_budget_usd: 0.01` and trigger captures → log shows `skipped: daily budget reached`, no Voyage calls. Restore default.

A green unit test is not acceptance for any of the five. Paste the commands, the real outputs, and the artifact reads. If a check cannot be proven, say so and stop.

---

## Constraints (hard)

- Secrets env-var only; never print/commit `VOYAGE_API_KEY`; no secret-shaped content in logs.
- No permanent deletions; archive instead.
- No live full re-embed to "test" — use mocks/fixtures. Real Voyage spend in drills > $0.05 → stop and ask.
- Windows + PowerShell 7. No OneDrive paths.
- Preserve all prior wins: durability, perf, write-guard, launcher, supervisor, daily-budget cap.

## Stop-and-ask

1. Debounce window default differs significantly from 30 s after measurement.
2. EBUSY persists after mutex (AV interference) — propose a documented retry-with-backoff path and stop.
3. Status-from-log read cost is non-trivial at scale (≫ 100k entries) — propose a daily roll-up file and stop.

## Output contract

- Phase 1 root-cause table with file:line.
- Phase 2 sources + what you took from each.
- Phase 3 options + recommendation per bug.
- Diffs/commits + test names.
- **Phase 5 live evidence:** real `auto-heal.jsonl` reads (before/after), live `/api/search` timings, live `auto-heal status` vs log sum.
- Residual risks + an updated operator runbook (no new operator commands expected).

## Definition of done ("not leaking")

- Re-read of `~/.memory/embeddings/auto-heal.jsonl` after the fix shows: same-path dup embeds gone in steady state, `EBUSY` count = 0, `auto-heal status` exactly equals log sum.
- All prior gains intact: durability, perf, launcher, supervisor, write-guard, daily budget.
- Every claim above backed by a command output or artifact read in the report.
