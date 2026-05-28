# Codex Implementation Brief — Autonomous Compile Execution (Phase 4.4)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> This opens a new arc (4.4 — autonomous consolidation). It is the **highest-risk** capability in the system: it mutates canonical wiki pages. Read the safety section twice. When in doubt, stop and ask.

---

## What this is

Today `memory compile` (in `src/cli/commands/compile.ts`, `runCompile()`) gathers raw observations since the last compile, renders the prompt template at `templates/prompts/compile.md`, and **writes the prompt to disk as an artifact**. It stops there. A human or agent then reads that prompt and manually creates/updates wiki pages. That's why the wiki goes stale (6 days, 1,173 raw observations un-consolidated, only 2 project pages) — nothing executes the prompt.

Phase 4.3.O scheduled compile, but scheduling a prompt-generator just produces fresh prompts on a cadence; it doesn't consolidate. This brief closes the loop: `compile --execute` sends the rendered prompt to the configured LLM (Phase 4.3.B provider abstraction), parses the structured page operations, **grounds** them (Phase 4.3.G/I), and applies them through the **confidence gate** (Phase 4.3.J) — high-confidence changes auto-apply, low-confidence land in the dashboard inbox for review.

### The safety property that makes this tractable

`templates/prompts/compile.md` is **append-only by contract**. Its rules (verified):

- "Do not rewrite existing wiki content. Append `## [<date>] update` sections only. Preserve audit trail."
- "Do not silently delete contradictions" — append new content + add `relations.contradicts`, never overwrite
- "Do not invent relations" / "Do not use marketing language" / "Do not bypass the privacy filter"
- New pages start `confidence: 0.5-0.7`, never 1.0

So a compile operation is one of: **CREATE** a new page, **APPEND** a dated section to an existing page, **UPDATE index.md** (add a link), **APPEND log.md** (one line). It never rewrites or deletes existing content. Combined with git as the backstop, the blast radius of a bad compile is bounded — and the grounding + confidence gate catch hallucinated content before it lands.

---

## Scope guard

You will:

### Task 1 — Execute mode on runCompile

- Extend `runCompile()` in `src/cli/commands/compile.ts` with an `execute?: boolean` option (default **false** — prompt-artifact mode stays the default until trusted):
  - When `execute: false` (today's behavior): render + write the prompt artifact, return as now. Unchanged
  - When `execute: true`: render the prompt, then call the LLM via `chatWithAudit({ consumer: "compile-execute", ... })` (Phase 4.3.B audited path), parse the response into structured page operations, ground them, and route through the apply pipeline (Tasks 2-4)
- Honor `MEMORY_LLM_DISABLED=true` — execute mode is a no-op (falls back to artifact mode) when LLM is disabled
- CLI: `memory compile --execute` (and `--execute --plan` to preview operations without writing)

### Task 2 — Parse compile output into page operations

- The compile prompt's output contract (see `templates/prompts/compile.md`) describes: new pages, updated pages (appended sections), skipped candidates, a summary. Define a parser `parseCompileOutput(content): CompileOperation[]` where each operation is a discriminated union:
  - `{ kind: "create"; path: string; frontmatter; body }`
  - `{ kind: "append-section"; path: string; section: string }` (a `## [<date>] update` block appended to an existing page)
  - `{ kind: "update-index"; entries: string[] }`
  - `{ kind: "append-log"; line: string }`
- The prompt currently emits a human-readable summary. **You will need to tighten `templates/prompts/compile.md` to emit a machine-parseable block** (e.g., a fenced ` ```compile-ops ` JSON/YAML section) IN ADDITION TO the human summary, so execute mode has a reliable contract. Keep the human summary for artifact-mode readers. Parser returns `{ ok: false, reason }` on malformed output (mirror the thread/procedure parser discriminated-union pattern from Phase 4.3.H)
- **Reject any operation that is not create / append-section / update-index / append-log.** If the model emits a "rewrite" or "delete" operation, drop it and record the rejection. Append-only is enforced in code, not just in the prompt

### Task 3 — Ground every operation

- Run each operation through `src/llm/proposal-grounding.ts` (Phase 4.3.G/I):
  - Strip any `relations.*` entry (in created pages or appended sections) that doesn't resolve to a real wiki/raw file
  - Strip prose-field path leaks
  - Enforce the command-prefix allowlist if any operation contains commands
- Reuse the existing grounding stats (`strippedReferenceCount`, `prosePathLeaksCount`) — do not build a parallel grounding implementation
- Privacy: run created/appended body text through the existing redaction/privacy filter (the one referenced in the compile prompt and `privacy.allowlist` in config). A compiled page must never contain a secret

### Task 4 — Confidence-gated apply (append-only)

- Score each operation via `src/llm/proposal-confidence.ts` (Phase 4.3.J):
  - High confidence (zero stripped refs, zero prose leaks, derived from ≥2 distinct sessions) → apply directly
  - Low confidence → stage to the inbox for review
- Apply mechanics (all via the Windows-safe `atomicWrite` from Phase 4.3.L):
  - `create`: write the new page (it didn't exist — no overwrite risk)
  - `append-section`: read existing page, append the dated section to the body, write back. **Never modify existing lines** — only append. Assert the original content is a prefix of the new content before writing (programmatic append-only guarantee)
  - `update-index` / `append-log`: append-only
- Staging for low-confidence: write to `wiki/compile-proposed/` (mirroring `threads-proposed/`) with the operation + a rendered diff, surfaced in the Phase 4.3.J inbox as a third section ("Compile changes awaiting review") with Approve/Reject. For `append-section`, the inbox shows the diff (existing page + proposed appended block)
- Respect the `auto_promote.confidence_threshold` config — if set to `none`, everything stages for review (never auto-applies); default `high` auto-applies high-confidence ops

### Task 5 — Wire into the scheduler + endpoint

- The Phase 4.3.O scheduler currently runs compile in artifact mode. Add a config flag `compile.execute` (default **false** — opt-in; the operator turns this on when they trust it). When true, the scheduled compile runs in execute mode
- `POST /api/compile/run` (Phase 4.3.O) gains an optional `{ execute: boolean }` body field, same-origin gated, so the operator can trigger an executed compile from the dashboard "Run compile now" button (with a confirm dialog warning that it will modify wiki pages)
- A verify check `compile.execute-health`: reports last execute run, ops applied vs staged, and the grounding strip rate — so the operator can see whether executed compiles are clean

### Task 6 — Docs

- `templates/schema.md`: document execute mode, the append-only guarantee, the `compile-ops` output contract, the confidence gate, and `compile.execute` config
- `docs/ROADMAP.md`: Phase 4.4 shipped — autonomous compile execution closes the consolidation loop

You will **not**:

- Make `execute: true` the default. Artifact mode stays default; execute is opt-in via flag/config until the operator trusts it on their vault
- Allow any operation that rewrites or deletes existing wiki content. Append-only, enforced in code with the prefix assertion. If the model proposes otherwise, drop + log it
- Blind-overwrite a page. `append-section` reads, appends, asserts prefix-preservation, writes
- Build a second LLM path, grounding layer, confidence scorer, or inbox. Reuse Phase 4.3.B / G / I / J infrastructure
- Bypass the privacy filter to keep "useful" content
- Auto-apply low-confidence operations. Those always stage for review
- Touch `git` directly. The auto-push hook (Phase 4.3.L) handles sync; compile just writes files
- Delete raw observations after compile. Retention is a separate concern
- Remove the prompt-artifact mode. Some operators may prefer to drive compile manually; both modes coexist

If the compile output for a real vault run turns out to be too unstructured to parse reliably even after tightening the prompt, **stop and ask** — we may need a more rigid output schema (tool-calling / JSON mode) rather than free-text parsing, which is a design decision worth your input.

If executing a compile against the live vault would touch more than ~10 pages in a single pass, **stop and ask** before applying — a large first executed compile should be operator-reviewed in full, not auto-applied, regardless of confidence.

---

## Repo orientation

- `src/cli/commands/compile.ts` — `runCompile()`; add execute mode here
- `templates/prompts/compile.md` — the prompt; add the machine-parseable `compile-ops` output block to the contract
- `src/llm/audit.ts` (Phase 4.3.B) — `chatWithAudit`; new consumer tag `compile-execute`
- `src/llm/proposal-grounding.ts` (Phase 4.3.G/I) — grounding; reuse for compile ops
- `src/llm/proposal-confidence.ts` (Phase 4.3.J) — confidence scorer; reuse
- `src/dashboard/proposed.ts` + `src/dashboard-ui/components/InboxPage.tsx` (Phase 4.3.J) — extend with a compile-ops section
- `src/dashboard/auto-promote-scheduler.ts` (Phase 4.3.O) — runs compile; add execute gating
- `src/dashboard/server.ts` — `POST /api/compile/run`; add `execute` body field
- `src/storage/atomic-write.ts` (Phase 4.3.L) — append-only writes
- privacy filter — find the existing redaction used at capture time; reuse for compiled bodies

---

## Acceptance contract

1. `memory compile --execute --plan` prints the proposed operations (create/append/index/log) without writing
2. `memory compile --execute` applies high-confidence grounded operations and stages low-confidence ones to `wiki/compile-proposed/` + the inbox
3. Every applied `append-section` provably preserves the original page content (prefix assertion); no existing line is ever modified or deleted
4. Operations with invented references are stripped by grounding; the strip rate surfaces in audit-summary + the new `compile.execute-health` check
5. A secret in raw content never reaches a compiled wiki page (privacy filter test)
6. `MEMORY_LLM_DISABLED=true` makes execute mode a no-op (artifact fallback)
7. `auto_promote.confidence_threshold: none` forces all compile ops to staging
8. Scheduled compile runs execute mode only when `compile.execute: true`; default stays artifact mode
9. Full test suite passes; build + build:ui + `tsc --noEmit` (after Phase 4.3.P) clean; `git diff --check` clean
10. After an executed compile against the live vault, project-page count rises to reflect real activity, and `memory lint` reports 0 frontmatter errors / 0 broken links

---

## Verification commands

```powershell
cd C:\CodexProjects\memory-system
node dist/cli.mjs compile --execute --plan      # preview ops, write nothing
node dist/cli.mjs compile --execute             # apply high-conf, stage low-conf
node dist/cli.mjs verify --role=operator | Select-String "compile"
# Review staged ops in the dashboard inbox; approve/reject
```

---

## Commit boundaries

- Task 1: `feat: compile --execute mode via audited LLM call (Phase 4.4 Task 1)`
- Task 2: `feat: parse compile output into append-only page operations (Phase 4.4 Task 2)`
- Task 3: `feat: ground + privacy-filter compile operations (Phase 4.4 Task 3)`
- Task 4: `feat: confidence-gated append-only apply with prefix guarantee (Phase 4.4 Task 4)`
- Task 5: `feat: scheduler + endpoint + verify check for executed compile (Phase 4.4 Task 5)`
- Task 6: `docs: autonomous compile execution (Phase 4.4 Task 6)`

---

## Dependencies / sequencing

- **Depends on Phase 4.3.Q** (exclude `.audit/` from entity enumeration) landing first — otherwise compile-execute would also see audit-log noise
- Benefits from **Phase 4.3.P** (typecheck gate) so the new code is type-checked
- Reuses 4.3.B (LLM), 4.3.G/I (grounding), 4.3.J (confidence + inbox), 4.3.L (atomic-write), 4.3.O (scheduler + endpoint) — all shipped

---

## Out-of-scope follow-ups

- Tool-calling / JSON-mode compile output (if free-text parsing proves unreliable) — revisit after the first real executed compiles
- Incremental re-compile of only-changed pages as a performance optimization
- Retention/pruning of raw observations after successful compile
- A compile "undo" beyond git revert
