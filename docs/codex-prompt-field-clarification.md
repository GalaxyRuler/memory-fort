# Codex Implementation Brief — Prompt Field Clarification (Phase 4.3.I)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Tight follow-up to Phase 4.3.G. Live-vault testing (2026-05-28, gpt-4o-mini, 10 grounded thread drafts written) confirmed the grounding filter works — zero hallucinated references in relations. But it also surfaced a **new regression**: the LLM is putting candidate wiki paths into prose fields where they don't belong.

Concrete examples from drafts just written:

`wiki/threads-proposed/tauri-project-configuration-testing-enhancements.md`:
```markdown
## Key decisions

- wiki/projects/agentmemory.md

## Key lessons

- wiki/projects/agentmemory.md
```

`wiki/threads-proposed/git-operations-bilingual-audit-implementation.md`:
```markdown
## Key decisions

- wiki/projects/agentmemory.md

## Key lessons

- wiki/projects/agentmemory.md
```

Both drafts are unusable as-is — the relations and prose summary are fine, but the structured `key_decisions[]` and `key_lessons[]` arrays got the candidate-list string dumped into them.

Root cause: the Phase 4.3.G prompt addition tells the LLM "Existing wiki pages you may reference (do not invent paths beyond these): [list]". The model is interpreting this as "use these paths in your output", and the YAML schema doesn't distinguish strongly enough between fields that take wiki paths (relations) versus fields that take free-form prose (key_decisions, key_lessons, open_questions, summary).

Fix: tighten the prompt so the candidate list is scoped explicitly to relation fields only. Free-form prose fields should never echo back a wiki path string.

---

## Scope guard

You will:

- Update the system prompt in `src/llm/thread-propose.ts`:
  - The "Existing wiki pages you may reference" section currently sits adjacent to the schema. Move/rewrite it so the LLM understands those paths belong ONLY in `relations.mentions[]` and `relations.derived_from[]`
  - Add an explicit anti-instruction: `Never put wiki/<category>/<slug> or raw/<date>/<file> path strings into free-form fields (summary, key_decisions, key_lessons, open_questions). Those fields are human-readable prose. The wiki path list applies to relations only.`
  - Consider showing a one-shot example in the prompt: a tiny `before/after` snippet where a wrong path-in-bullet is corrected to prose-in-bullet
- Mirror the same prompt tightening in `src/llm/procedure-propose.ts`:
  - Same anti-instruction for procedure fields (`summary`, `preconditions`, `steps[].description`, `verification`, `failure_cases`)
  - The procedure pipeline has the command allowlist in a similar position; review whether commands are leaking into prose fields too (live testing didn't run that pipeline successfully so we don't know yet)
- Add a post-process check in `src/llm/proposal-grounding.ts` (or as a new sibling module if it doesn't fit) that detects path-string leakage in prose fields:
  - For thread proposals: scan `summary`, `keyDecisions[]`, `keyLessons[]`, `openQuestions[]` for entries that match `/^(wiki|raw)\/[a-z0-9-]+\//` and either (a) drop them and record in grounding stats, or (b) reject the whole proposal as malformed. Pick the conservative option: drop+record, since the surrounding prose is often still useful
  - For procedure proposals: same scan on `summary`, `preconditions[]`, `verification[]`, `failureCases[].condition`, `failureCases[].remedy`. Same drop+record behavior
  - Extend the `grounding` stats object: add `prosePathLeaksCount` and `prosePathLeakSamples[]` alongside the existing `strippedReferenceCount` / `commandsStripped`
- Surface the new counter in `memory provider audit-summary` next to the existing reference-stripped rate. A non-zero `prosePathLeaks` rate is the operator's signal that the prompt still isn't tight enough
- Tests:
  - Unit test: parser receives a proposal with path strings in `key_decisions` — verify the leak is stripped and counted
  - Integration test: stub LLM that emits a path-leaked response — verify the orchestrator records the leak and writes a clean draft (or rejects, per the chosen behavior)
  - Snapshot the updated prompt strings so future regressions are visible in diffs

You will **not**:

- Change the existing relations-grounding logic from Phase 4.3.G. That layer works correctly; this brief only adds a sibling check for the prose-field side
- Add the prose check at the YAML-parse layer. Keep parser logic structural; semantic checks belong in `proposal-grounding.ts`
- Re-write the 10 thread drafts already in `wiki/threads-proposed/`. Operator rejects them or re-runs propose after this lands. Per Phase 4.3.G's precedent, the orchestrator does not retroactively fix existing drafts
- Add few-shot in-prompt examples that include real wiki pages from the user's vault — those examples leak across runs even after the prompt change. Use synthetic example paths (e.g., `wiki/decisions/example-decision-page.md`) or none at all
- Touch the procedure pipeline's parser-rejection mystery from 4.3.H. That work is independent and may overlap with this brief's procedure changes; coordinate ordering if both are in flight, but don't bundle
- Add a CLI flag to skip the prose-leak check. The check is always-on; if a draft genuinely needs a wiki path mentioned in prose, the operator can hand-edit after promotion

If the post-process check turns out to strip legitimate prose mentions of a real file (e.g., "we updated wiki/projects/lisan-studio.md to reflect the new milestone"), **stop and ask**. The expected leak shape is bare path strings as bullet items; prose mentions embedded in sentences are harder to filter and may need a different heuristic (e.g., only strip if the entire bullet content is just a path).

---

## Repo orientation

- `src/llm/thread-propose.ts` — `systemPrompt(candidates)` near line 144. Anti-instruction goes here. `parseThreadProposal()` and `groundThreadProposal()` already exist from 4.3.G
- `src/llm/procedure-propose.ts` — `systemPrompt(candidates)` and `groundProcedureProposal()`. Mirror structure
- `src/llm/proposal-grounding.ts` — pure module from 4.3.G. New prose-leak detection lives here, or in a sibling module if it grows past a couple of functions
- `src/cli/commands/provider.ts` — `audit-summary` surface. Extend the per-consumer rollup with the new counter
- `templates/schema.md` — document the new prose-leak counter under the grounding section

---

## Acceptance contract

1. Re-running `memory thread propose --plan` after this lands produces drafts where every entry in `keyDecisions[]` and `keyLessons[]` is human prose, not a wiki/raw path string
2. If a draft would have leaked a path into prose, the orchestrator logs the leak count and the draft still writes (path stripped, prose around it preserved)
3. `memory provider audit-summary` shows the new `prosePathLeaks` rate per consumer
4. Existing Phase 4.3.G grounding stats (relations stripped, commands stripped) continue working unchanged
5. Full test suite passes including the new prose-leak tests
6. The 10 currently-written drafts at `wiki/threads-proposed/*.md` are not modified by this brief — operator decides whether to reject or wait-and-re-run

---

## Out-of-scope follow-ups

Tracked separately, do not bundle:

- LLM debug logging (Phase 4.3.H, brief at `docs/codex-llm-debug-logging.md`)
- Cost-tracking fix for gpt-4o-mini ($0.0000 in audit-summary)
- Free-form prose quality improvements (the `## Open questions` sections are often shallow — that's a prompt-engineering follow-up, not a grounding fix)
