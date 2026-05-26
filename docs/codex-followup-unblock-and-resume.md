# Codex Implementation Brief — Unblock Task A6 + Resume Remaining Tasks

**Target**: Codex 5.5 (parallel subagents OK)
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Resumes the two prior briefs (`codex-installer-hooks-and-graph-bugs.md` and `codex-universal-capture.md`) after the subagent run was stopped on a Task A6 acceptance blocker. The blocker has a root-cause fix surfaced here as Task 0. Everything not started in the original briefs is enumerated below for clarity.

### What already landed (don't redo)

| Brief | Task | Status | Commit |
|---|---|---|---|
| Bugs | A1 claude-code plugin enablement | ✅ pushed | `fe942c8` |
| Bugs | A8 memory verify | ✅ pushed | `4242f2b` |
| Bugs | A6 cognitive inference (partial — see Task 0 below) | ✅ pushed | `9ac9bcf` |
| Capture | B1 sniffer framework | ✅ pushed | `8550ab4` |
| Capture | B2 Claude Code backfill sniffer | ✅ pushed | `0f3a060` |
| Capture | B7 memory backfill command | ✅ pushed | `bd30a99` |

### What's left

| Brief | Task | Notes |
|---|---|---|
| **This brief** | **Task 0** unblock A6 (timestamp from UUIDv7) | NEW — addresses the A6 blocker root cause |
| Bugs | A2 galactic camera | UI |
| Bugs | A3 VS Code Windows path | quick |
| Bugs | A4 claude-desktop repair | quick |
| Bugs | A5 auto-push tempfile race | cleanup |
| Bugs | A7 cross-galaxy edges | UI |
| Bugs | A9 legend node counts | UI (and depends on A6 producing a distribution to count) |
| Capture | B3 Antigravity 2.0 plugin | new feature |
| Capture | B4 Claude Desktop watcher | new feature |
| Capture | B5 VS Code extension | new feature |
| Capture | B6 memory watch daemon | wraps B3/B4/B5 |
| Capture | B8 verify integration | depends on B3/B4/B5/B6 |

---

## Task 0 — Unblock A6: timestamp preservation for migrated observations

### Why
A6's rebalance heuristic uses `created` to age raw observations into `semantic` once they're >30 days old. But the agentmemory migration set every imported file's `created` to the migration date (2026-05-26 — today). So all 1074 migrated observations look "recent" and stay episodic. Result: A6 ships logically but the live distribution remains 2/11/1074/5 instead of the expected ~5/700/300/40 spread.

The fix is to derive an **observation timestamp** from the data we already have:
1. `imported_from.original_key` is something like `mem:obs:019e45fc-5e01-7180-9f0c-114a3b1f941a`. The UUID prefix is **UUIDv7-encoded** — the first 48 bits are a unix-milliseconds timestamp.
2. Parse that timestamp on import and use it as the source for the age check, NOT `created`.

### Contract

In `src/migration/map-agentmemory.ts` (or wherever the import writes frontmatter):

- When `imported_from.original_key` matches `mem:<scope>:<uuidv7>` (regex: `^mem:[a-z]+:([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})$`), extract the UUID
- Decode the timestamp from the first 12 hex chars (48-bit unix-ms big-endian: take chars 0–8 + 9–12, strip the hyphen, parse as hex, that's the ms-since-epoch)
- Write the ISO date string to a new frontmatter field `observed_at: <YYYY-MM-DD>` (don't overwrite `created` — it preserves the file-creation lineage)
- For non-UUIDv7 keys, leave `observed_at` unset

In `src/retrieval/corpus.ts:applyCognitiveTypeInference`:

- Change the age check from `created` to `observed_at ?? created`
- This way migrated observations age correctly based on when they actually happened (May 19-20) instead of when they were imported (today)

This is a **one-pass migration**: write a small CLI command `memory rewrite-imported-timestamps` (or extend `memory migrate` if such command exists) that walks every existing imported file under `~/.memory/` and adds the `observed_at` field. Idempotent — skip files that already have it.

### Acceptance

After running the rewrite:
- 1000+ files in `~/.memory/raw/` get an `observed_at` field
- `memory verify` shows the cognitive distribution shifted: `episodic` drops by 70–90% (recent observations from the last 30 days stay episodic; older agentmemory observations become semantic)
- The galactic graph at `/memory/graph` visibly splits across 4 galaxies instead of one Episodic blob

### Files

- New: `src/migration/uuidv7-timestamp.ts` (pure decoder, fully unit-testable)
- New: `src/cli/commands/rewrite-imported-timestamps.ts`
- Modify: `src/migration/map-agentmemory.ts` (set `observed_at` during import going forward)
- Modify: `src/retrieval/corpus.ts:applyCognitiveTypeInference` (use `observed_at ?? created`)
- Modify: `src/retrieval/corpus.ts:SearchDocument` (add `observedAt: string | null`)
- New: `test/migration/uuidv7-timestamp.test.ts`
- New: `test/cli/commands/rewrite-imported-timestamps.test.ts`
- Extend: `test/retrieval/cognitive-type-inference.test.ts` with an `observed_at`-driven case

### UUIDv7 timestamp decode reference

UUIDv7 layout (RFC 9562):
```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           unix_ts_ms                          |  (48 bits)
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          unix_ts_ms           |  ver  |       rand_a          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|var|                        rand_b                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                            rand_b                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Reference implementation:
```ts
export function uuidv7ToTimestamp(uuid: string): Date | null {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) return null;
  if (hex[12] !== "7") return null; // version nibble must be 7
  const tsHex = hex.slice(0, 12); // first 48 bits
  const ms = parseInt(tsHex, 16);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms);
}
```

### Test cases
- Known UUIDv7 → expected date (verify against the user's actual data: `019e45fc-5e01-7180-9f0c-114a3b1f941a` should decode to a date in May 2026)
- Non-UUIDv7 (v4, etc.) → null
- Malformed strings → null
- Real agentmemory keys from the user's vault → all decode to dates in the expected May 19-22 range

---

## Resumed tasks (Tasks A2, A3, A4, A5, A7, A9, B3, B4, B5, B6, B8)

These read identically to the prior briefs. Read them in:

- `docs/codex-installer-hooks-and-graph-bugs.md` (the ones starting with A)
- `docs/codex-universal-capture.md` (the ones starting with B)

Skip the tasks that already landed (A1, A6, A8, B1, B2, B7). Do the rest.

### Execution order

After Task 0 (unblock A6) lands:

1. **Task 0** (unblock A6) — restores the cognitive distribution, makes A9 meaningful, prerequisite for the galactic visual changes (A7, A9)
2. **A9 legend node counts** — once A6 actually shifts the distribution, the legend counts become informative
3. **A7 cross-galaxy edges** — pairs with A6/A9
4. **B3 Antigravity 2.0 plugin** — biggest gap closer in capture
5. **B4 Claude Desktop watcher** — second biggest
6. **B5 VS Code extension** — completes capture surfaces
7. **B6 memory watch daemon** — coordinates B3/B4/B5
8. **B8 verify integration** — last because depends on B3-B6
9. **A3 VS Code Windows path** — quick win
10. **A4 claude-desktop repair** — quick win
11. **A5 auto-push tempfile race** — cleanup
12. **A2 galactic camera default-target** — UX polish, save for last

Same parallel-subagent pattern OK. Suggested split:
- **Subagent A**: Task 0 → A9 → A7 → A3 → A4 → A5 → A2
- **Subagent B**: B3 → B4 → B5 → B6 → B8

Subagent A's Task 0 should land first, then Subagent B starts. Otherwise B might land changes that interact with the corpus loader in unexpected ways.

---

## Coordination rules

- Read the original briefs for the full Task contracts; this brief only adds Task 0 and lists what remains.
- Commit per numbered task. Each commit message references the task ID (e.g., "feat: cross-galaxy edge visibility (A7)").
- `src/cli.ts` is the only file likely to be touched by both subagents. Second-to-commit rebases.
- All 675+ tests must stay green per commit.
- No VPS deploy. Operator runs `npm run build && npm run build:ui && manual scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs && rsync dist/dashboard-ui/ root@srv1317946:/root/memory-system/dashboard-ui/ && ssh root@srv1317946 'systemctl restart memory-dashboard'` (the install-vps chunked-upload path is broken; the operator uses the manual path).
- Push per task to origin/main. The shared checkout is `C:\CodexProjects\memory-system`.

---

## Acceptance checklist (cumulative across all three briefs)

Already done:
- [x] Claude Code plugin enablement landed
- [x] memory verify command exists
- [x] Sniffer framework defined
- [x] Claude Code backfill sniffer exists
- [x] memory backfill command exists

This brief delivers:
- [ ] Task 0: UUIDv7-decoded `observed_at` field on every migrated observation, age check uses it, live distribution shifts to ~episodic 200–400 / semantic 600–800 / procedural 30–80 / core 5–20
- [ ] A2 galactic camera targets nearest galaxy, not always Semantic
- [ ] A3 VS Code Windows path resolves correctly
- [ ] A4 claude-desktop installer repairs corrupted entries
- [ ] A5 auto-push tempfile race fixed; errors.log stops growing
- [ ] A7 cross-galaxy edges visibly bolder than within-galaxy
- [ ] A9 legend shows live node counts per row
- [ ] B3 Antigravity 2.0 plugin captures live sessions
- [ ] B4 Claude Desktop watcher captures live sessions
- [ ] B5 VS Code extension captures live sessions
- [ ] B6 memory watch coordinates B3/B4/B5
- [ ] B8 memory verify reports sniffer health
- [ ] All 675+ tests still green; new tests cover Task 0 + every resumed task
- [ ] No secrets, no OneDrive paths

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.
