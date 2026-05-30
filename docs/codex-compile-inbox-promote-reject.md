# Codex Implementation Brief — Compile Proposal Promote/Reject in Inbox (Phase 4.17)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The inbox (`/memory/inbox`) shows compile proposals from `wiki/compile-proposed/` but the Promote and Reject buttons **do nothing** — clicking either one shows a dead notice "Compile proposals are staged for manual review" and returns immediately. The backend promote/reject also silently falls through to the procedure path for `kind: "compile"`.

Observed live (2026-05-30): 4 staged proposals visible in the inbox with no way to act on them. The operator has to use the CLI to review.

Two places broken:
1. **`src/dashboard/proposed.ts`** — `promoteProposedDraft()` and `rejectProposedDraft()` only handle `"thread"` and `"procedure"`. `"compile"` kind falls to the procedure branch (wrong, and would 404).
2. **`src/dashboard-ui/components/InboxPage.tsx` line 52-55** — `runAction` bails early for `compile` kind: `if (draft.kind === "compile") { setNotice("Compile proposals are staged for manual review."); return; }`.

---

## What compile promote/reject should do

A compile proposal in `wiki/compile-proposed/<slug>.md` contains:
- A `compile-op` JSON block (the operation that was staged: `write_page`, `append_page`, `update_index`, or `append_log`)
- The target path is stored in the frontmatter/body as `wiki/projects/iaqar.md` etc.

**Promote**: parse the `compile-op` JSON from the body, re-apply it as a direct vault write (bypassing the confidence gate — the operator has reviewed it), then delete the proposal file. Equivalent to: extract the op, apply it via the existing `applyOperation()` in `src/compile/execute.ts`, commit the result via `commitVaultChange`, delete `wiki/compile-proposed/<slug>.md`.

**Reject**: delete `wiki/compile-proposed/<slug>.md` and commit the deletion. No other vault changes.

Both follow the same append-only contract: the promoted `write_page` creates a new page, the promoted `append_page` appends a dated section — never overwrites existing content.

---

## Scope guard

### Task 1 — Backend: implement compile promote/reject

In `src/dashboard/proposed.ts`:
- `promoteProposedDraft(vaultRoot, "compile", slug)`: read the proposal file, extract the `compile-op` JSON block, call `applyOperation(vaultRoot, operation)` from `src/compile/execute.ts` (export it if not already exported), then delete the proposal file, then `commitVaultChange({ paths: [targetPath, proposalPath], message: "promote compile proposal: <slug>" })`.
- `rejectProposedDraft(vaultRoot, "compile", slug)`: delete the proposal file, `commitVaultChange({ paths: [proposalPath], message: "reject compile proposal: <slug>" })`.
- Add `"compile"` to the `ProposedKind` union if not already there.
- Return shapes consistent with the thread/procedure cases (`{ promotedPath }` / `{ rejectedPath }`).

### Task 2 — UI: enable the Promote/Reject buttons for compile proposals

In `src/dashboard-ui/components/InboxPage.tsx`:
- Remove the `if (draft.kind === "compile") { setNotice(...); return; }` bail (lines 52-55).
- The buttons already call `runAction` and `POST /api/proposed/promote` / `reject` — they just need to not bail. The backend will now handle the `compile` kind.
- Show a confirm dialog before promote (it writes to canonical memory): `"Apply compile proposal ${draft.title}? This will write to your wiki."` — same pattern as the existing reject confirm.
- After a successful promote, hide the card (same `setHidden` logic as threads/procedures).

### Task 3 — Tests

- Backend test: `promoteProposedDraft(vaultRoot, "compile", slug)` on a fixture compile-proposed file → the target page is created/appended AND the proposal file is deleted.
- Backend test: `rejectProposedDraft(vaultRoot, "compile", slug)` → proposal file deleted, vault otherwise unchanged.
- UI test: clicking Promote on a compile draft fires `POST /api/proposed/promote` with `kind: "compile"` (not bailing with a notice).

### Task 4 — Docs

- `docs/ROADMAP.md`: Phase 4.17 shipped.

You will **not**:
- Change the compile execution engine or the confidence-gating. This is purely the review/apply step after the operator clicks Promote.
- Change the propose or stage behavior.
- Add re-grounding on promote (the proposal was already grounded when staged; re-grounding is a future enhancement).

If `applyOperation` is entangled with execute-only state (audit tracking etc.) and can't be cleanly exported, **stop and ask** — a simpler fallback is to re-parse the op and do a direct `atomicWrite`/`atomicAppend`.

---

## Acceptance contract

1. Clicking Promote on a compile proposal in the inbox → confirm dialog → the target wiki page is created/appended → proposal file deleted → card disappears from inbox.
2. Clicking Reject → proposal file deleted → card disappears.
3. Both commit the vault change and the existing auto-push propagates.
4. Full suite + typecheck + build clean.

---

## Commit boundaries

- Task 1: `feat: compile proposal promote/reject in backend (Phase 4.17 Task 1)`
- Task 2: `feat: enable Promote/Reject buttons for compile drafts in inbox (Phase 4.17 Task 2)`
- Task 3-4: `test+docs: compile inbox promote/reject (Phase 4.17)`
