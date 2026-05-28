# Codex Implementation Brief — Dashboard Inbox + Confidence-Gated Auto-Promote (Phase 4.3.J)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The Phase 4.3 A-I sequence shipped a propose → review → promote pipeline that's correct but operator-heavy: every draft requires a CLI invocation to promote or reject. The operator has asked to be taken out of the loop where it's safe to do so.

This brief delivers two stacked improvements:

1. **Confidence-gated auto-promote.** A `propose --apply --auto-promote` mode that bypasses `wiki/<kind>-proposed/` for high-confidence drafts (zero references stripped + zero prose-leaks + cluster ≥5 obs + ≥2 distinct sessions) and writes them straight to `wiki/<kind>/`. Low-confidence drafts land in `proposed/` as today
2. **Dashboard inbox.** A `/inbox` route on the dashboard listing drafts in `threads-proposed/` and `procedures-proposed/` with a confidence badge, the draft prose preview, and one-click `Promote` / `Reject` buttons. A header badge shows the count of drafts awaiting review. Scheduled propose runs (configurable cadence) are managed from the existing Settings page

After this lands, the operator's experience is: clean drafts auto-promote on schedule, only flagged drafts surface for review, review takes one click on the dashboard. Terminal CLI continues to work — the dashboard is additive, not a replacement.

The safety net stays. Yesterday's confabulated drafts would have hit non-zero `prosePathLeaksCount` or `strippedReferenceCount` and been routed to `proposed/` for review, not auto-promoted. The confidence scorer encodes the signals that already caught the regression — it doesn't introduce new risk.

---

## Scope guard

You will:

### Task 1 — Confidence scorer

- Add `src/llm/proposal-confidence.ts`:
  - Pure function `scoreProposalConfidence(input): { level: "high" | "low"; reasons: string[] }`
  - Input shape (works for both thread and procedure proposals):
    ```ts
    interface ConfidenceInput {
      grounding: {
        strippedReferenceCount: number;
        prosePathLeaksCount: number;
        commandsStripped?: string[];
      };
      cluster: {
        observationCount: number;
        distinctSessions: number;
      };
    }
    ```
  - High confidence iff ALL: `strippedReferenceCount === 0` AND `prosePathLeaksCount === 0` AND `(commandsStripped?.length ?? 0) === 0` AND `observationCount >= 5` AND `distinctSessions >= 2`
  - Reasons array always populated — when low, lists the specific signals that failed (e.g., `"prosePathLeaksCount=2"`, `"observationCount=3 below threshold 5"`); when high, contains a single `"all signals clean"`
  - Thresholds (`MIN_OBS_COUNT`, `MIN_DISTINCT_SESSIONS`) defined as exported constants so settings UI / docs can show them
- Test: each signal individually trips low confidence; all clean trips high; cluster-size and distinct-session thresholds enforced

### Task 2 — Auto-promote integration

- `src/cli/commands/thread.ts` and `src/cli/commands/procedure.ts` accept a new `--auto-promote` flag (combined with `--apply`; ignored without it)
- When set, after a draft is written, the orchestrator scores it via the confidence module:
  - High confidence → move from `wiki/<kind>-proposed/<slug>.md` to `wiki/<kind>/<slug>.md` (same writer used by today's `memory thread promote` command — extract to shared helper if needed)
  - Low confidence → stay in `proposed/` as today
- Run summary distinguishes the two paths: `Drafts auto-promoted: N`, `Drafts awaiting review: M`
- Audit-log row records `autoPromoted: boolean` per proposal
- Tests: --auto-promote flag with mixed-confidence proposals routes correctly; without the flag, all drafts stay in `proposed/` (back-compat)

### Task 3 — Dashboard server endpoints

- Add to `src/dashboard/server.ts` (follow the existing PATCH `/api/config` pattern from Phase 4.3.C — same-origin check, `writeJson` helper, error shape):
  - `GET /api/proposed/threads` → array of `{ slug, title, observationCount, distinctSessions, timeRange, confidence, prosePreview }`. `confidence` is the new scorer's output. `prosePreview` is the first paragraph of body text (≤300 chars). Reads from `wiki/threads-proposed/*.md`
  - `GET /api/proposed/procedures` → same shape adapted for procedures (`commandSignature` instead of timeRange, `steps` count)
  - `POST /api/proposed/promote` → body `{ kind: "thread" | "procedure"; slug: string }`. Same-origin gated. Moves the file, returns `{ ok: true, promotedPath }`
  - `POST /api/proposed/reject` → same body shape. Same-origin gated. Calls the same logic the CLI uses (move-to-archive or delete — match CLI behavior exactly)
  - `GET /api/proposed/summary` → counts of low/high confidence drafts per kind. Lets the header badge stay cheap to fetch
- All endpoints honor `MEMORY_LLM_DISABLED=true` only insofar as they don't trigger new propose runs (read/move operations don't touch LLM)
- Add server tests in `test/dashboard/server.test.ts`: each endpoint returns the right shape, same-origin enforcement on POSTs, missing slug → 404, malformed body → 400

### Task 4 — Scheduled propose runs

- Add `auto_promote:` block to `~/.memory/config.yaml` schema:
  ```yaml
  auto_promote:
    enabled: false           # default off
    cadence: "weekly"        # weekly | daily | manual
    confidence_threshold: high  # high (recommended) | none (auto-promote everything — discouraged)
  ```
- Server-side scheduler in `src/dashboard/server.ts` (or a sibling module if it grows):
  - On dashboard startup, read `auto_promote` config
  - If `enabled === true`, register a `setInterval` or `setTimeout` that fires per `cadence` (weekly = 7d, daily = 24h, manual = no-op)
  - Each fire runs `proposeThreads({ apply: true, autoPromote: true })` then `proposeProcedures({ apply: true, autoPromote: true })`. Uses the existing orchestrator functions — no duplication
  - Errors log to `~/.memory/errors.log` with timestamp; never crash the dashboard
  - The scheduler shuts down cleanly on `SIGTERM` (just `clearInterval`)
- Tests: scheduler off → no fires; on with mocked clock → fires at expected cadence; failure inside a fire logs but doesn't kill the dashboard

### Task 5 — Dashboard UI inbox

- Add `src/dashboard-ui/routes/inbox.tsx`:
  - Two collapsible sections: "Threads awaiting review" and "Procedures awaiting review"
  - Each draft renders as a card with: title, confidence badge (color-coded — green for high, amber for low with the reasons displayed), observation count + distinct sessions, prose preview, expand button to see full draft body
  - Promote button (green) → POST `/api/proposed/promote` → optimistic UI update → toast on success
  - Reject button (red, with confirm modal) → POST `/api/proposed/reject` → optimistic UI update
  - Empty state when no drafts await review: "Inbox zero. Auto-promote handled N drafts in the last 7 days." (count from audit log)
- Add header badge component near existing nav (look for `App.tsx` or layout) showing the count from `/api/proposed/summary`. Badge links to `/inbox`. Hidden when count is zero
- Add route to `src/dashboard-ui/routeTree.gen.ts` (or however the route tree is regenerated — there's a build step somewhere)
- Tests: inbox renders both lists; promote/reject buttons fire the right POSTs; empty state shows; badge count updates after promote/reject

### Task 6 — Settings page extension

- Extend the existing settings page from Phase 4.3.C (`src/dashboard-ui/routes/settings.tsx` or similar) with a new "Auto-promote" card:
  - Toggle: "Enable auto-promote" — writes `auto_promote.enabled` via PATCH `/api/config`
  - Radio: "Cadence" — weekly / daily / manual
  - Read-only: "Confidence threshold" with explanation text. Don't expose `none` in the UI (it's discouraged) — operators who want it can hand-edit `config.yaml`
  - Link: "View inbox →" to `/inbox`
- Same-origin PATCH already exists from 4.3.C — extend the safelist to include `auto_promote.*` paths
- Tests: settings card renders, toggle PATCHes the correct path, safelist accepts `auto_promote.*`

### Task 7 — Docs

- `templates/schema.md`: new "Auto-promote" section documenting the confidence rules (the exact threshold values from Task 1), the scheduler cadences, the dashboard inbox URL, and the config.yaml shape
- `docs/ROADMAP.md`: mark Phase 4.3.J shipped 2026-05-28, closing the Phase 4.3 operator-experience arc
- Brief mention in the existing dashboard docs (if any) of the new `/inbox` route and the header badge

You will **not**:

- Remove the existing CLI promote/reject commands. Dashboard is additive, terminal remains the power-user surface
- Auto-promote *everything* by default. The default for `confidence_threshold` is `high`, never `none`
- Add user authentication to the dashboard. Same-origin check from 4.3.C is the security boundary
- Expose the LLM debug log (Phase 4.3.H) via the dashboard. That's deliberately gated to local filesystem only
- Run the scheduler in a separate Node process. Keep it in the dashboard process — simplifies lifecycle
- Add notifications/webhooks/email on auto-promote events. Header badge + audit log is enough
- Build retry logic if a scheduled propose run fails. Log the error, wait for next cadence, operator can intervene manually
- Persist scheduler state across restarts (e.g., "last ran at"). The interval is wall-clock-driven, not state-driven. If the dashboard was down at the scheduled time, the next fire is on the next cadence
- Add a confidence override per draft. Either the signals are clean or they're not — operator can hand-edit the file or use the CLI if a low-confidence draft is actually fine

If during implementation the scheduler turns out to need more than a simple `setInterval` (e.g., real cron syntax, missed-fire handling), **stop and ask** before adding `node-cron` or a job-queue library. The baseline is minimum-invasive.

---

## Repo orientation

- `src/llm/proposal-grounding.ts` (Phase 4.3.G/I) — grounding stats shape lives here. Confidence scorer imports from this
- `src/cli/commands/thread.ts` (Phase 4.3.D) — orchestrator. `--auto-promote` flag lives here, calls confidence scorer + promote helper
- `src/cli/commands/procedure.ts` (Phase 4.3.E) — same structure
- `src/cli/commands/{thread,procedure}.ts` — also contain the promote and reject logic that's currently CLI-only. Extract the file-move primitive to a shared helper so the new server endpoints reuse the same code
- `src/dashboard/server.ts` — request handler. New endpoints slot in alongside `/api/config`, `/api/health`, `/api/status`. Reuse `sameOriginAllowed`, `writeJson`, `readJsonBody`, `writeJsonError`
- `src/dashboard/config-patch.ts` (Phase 4.3.C) — safelist for PATCH `/api/config`. Extend to allow `auto_promote.enabled`, `auto_promote.cadence`, `auto_promote.confidence_threshold`
- `src/dashboard-ui/routes/` — TanStack Router routes. New `inbox.tsx` and updates to `settings.tsx`. `routeTree.gen.ts` auto-regenerates on build
- `src/dashboard-ui/components/` — existing components include `Card`, `Button`, `BottomSheet`, `EmptyState`. Reuse aggressively rather than building new primitives
- `templates/schema.md` — the existing "Diagnostic env vars" section is a good neighbor for the new "Auto-promote" section
- `docs/ROADMAP.md` — Phase 4.3.J ships entry

---

## Acceptance contract

1. `node dist/cli.mjs thread propose --apply --auto-promote` against the live vault writes high-confidence drafts directly to `wiki/threads/`, low-confidence drafts to `wiki/threads-proposed/`. Run summary distinguishes the two
2. Without `--auto-promote`, behavior is unchanged from today — all drafts go to `proposed/`. Back-compat
3. Dashboard `/inbox` route renders both kinds of drafts with confidence badges. Promote and Reject buttons work and update the UI optimistically
4. Header badge shows the count of drafts awaiting review across both kinds. Hidden when zero. Links to `/inbox`
5. Settings page Auto-promote card writes the config block via PATCH `/api/config`. Same-origin enforced
6. With `auto_promote.enabled: true` and `cadence: "weekly"`, the dashboard scheduler runs propose pipelines once per 7d. Errors log to `~/.memory/errors.log` without crashing
7. Full test suite passes (current baseline is 1001 tests after Phase 4.3.H/I). New tests cover the confidence scorer, the auto-promote CLI flag, the four new endpoints, the inbox UI, the settings extension, and the scheduler
8. `git diff --check` clean
9. No live-vault drafts are touched by tests. No actual LLM calls made in tests beyond the existing stub patterns
10. `npm run build` and `npm run build:ui` both pass

---

## Verification commands

Operator runs after the brief lands (not Codex):

```powershell
cd C:\CodexProjects\memory-system

# 1. CLI auto-promote dry run
node dist/cli.mjs thread propose --plan --auto-promote
# Output should show "would auto-promote N" vs "would route to review M"

# 2. Apply with auto-promote
node dist/cli.mjs thread propose --apply --auto-promote
# Inspect wiki/threads/ for high-confidence; wiki/threads-proposed/ for review-needed

# 3. Dashboard inbox
# Open dashboard, navigate to /inbox
# Verify badge count matches threads-proposed/ count
# Click Promote on one draft → it moves to wiki/threads/

# 4. Scheduler
# Settings → Auto-promote → enable, cadence=daily
# Wait for next fire (or stub time in test) → check logs

# 5. Errors don't crash
# Stop the LLM provider mid-fire (kill OpenRouter key) → next fire logs error → dashboard still up
```

---

## Commit boundaries

Suggested chunking (7 commits, one per task above):

- Task 1: `feat: proposal confidence scorer (Phase 4.3.J Task 1)`
- Task 2: `feat: --auto-promote flag on propose orchestrators (Phase 4.3.J Task 2)`
- Task 3: `feat: /api/proposed/* dashboard endpoints (Phase 4.3.J Task 3)`
- Task 4: `feat: scheduled propose runs (Phase 4.3.J Task 4)`
- Task 5: `feat: dashboard inbox route + header badge (Phase 4.3.J Task 5)`
- Task 6: `feat: settings auto-promote card (Phase 4.3.J Task 6)`
- Task 7: `docs: auto-promote schema + roadmap (Phase 4.3.J Task 7)`

---

## Out-of-scope follow-ups

Tracked separately, do not bundle:

- Cost-tracking fix for gpt-4o-mini ($0.0000 — stale pricing table). Cosmetic, not blocking
- Prose-quality improvements (the bullet content in current drafts is generic — "Effective use of Git commands streamlines workflow"). Separate prompt-engineering work
- Auto-reject of stale low-confidence drafts (e.g., "reject anything in proposed/ for >30 days"). Operator can do this manually for now; revisit if the inbox accumulates
- Cross-kind dependencies (a thread that mentions a procedure — promote them together). Threads and procedures are independent today; combined promotion is a separate feature
- Audit-log rotation. The `.audit/llm-*.md` files grow forever. Out of scope for the inbox feature
- Public/multi-user dashboard. Same-origin only, single-operator, that's the model
