# Codex Implementation Brief — Fix the Title-Match Scorer (Phase 4.37.2)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> 4.37.1's degeneracy guard + mass-collision backstop + embedding-health check are **correct and verified**. But the **title/lexical fallback scorer itself is broken** — it produces `title 1.000` matches on raw sessions with **zero topical overlap**. Verified by reading: `codex-019e47ce` → `curation-orchestrator-not-llm.md` at 1.000, but that raw mentions "curation"/"orchestrator"/"compile" **0 times**. Two more spot-checks: same (curation=0, orchestrator=0, payload=0). **`auto_link.enabled` defaults true and auto-link runs at capture time (post-tool-use hook)**, so this scorer would write false `mentions` edges into every new capture. **4.37/4.37.1 must NOT land until this is fixed.**

## Root cause (verified in `src/capture/auto-link.ts` `titleMatchScore`, ~line 281)

```ts
const supportCoverage = supportTokens.size === 0 ? 0 : supportOverlap / Math.min(3, supportTokens.size);
```

**Bug 1 — saturation denominator.** `Math.min(3, supportTokens.size)` caps the denominator at 3. Any raw session that shares **3 generic tokens** with a candidate's summary/body (e.g. "memory", "code", "file", "system", "session") gets `supportCoverage = 3/3 = 1.0`, contributing the full `0.43` weight regardless of real relevance.

**Bug 2 — numeric/date tokens not stripped.** `tokenSet` keeps tokens of length > 1, so wiki titles like `2026-05-22-curation-orchestrator-not-llm` yield `{2026, 05, 22, curation, orchestrator, llm}`. Every dated raw session contains `2026`, `05`, etc. → inflates `titleCoverage` via date/number collisions, not topical match.

**Combined effect:** `score = titleCoverage*0.42 + supportCoverage*0.43 + jaccard*0.15 + phraseBonus`, clamped to 1. Date-token title overlap + 3-generic-token support saturation pushes unrelated pages to `min(1, …) = 1.000`.

## Task 1 — Fix the scorer so it measures real topical overlap

In `titleMatchScore`:
1. **Remove the saturation cap.** `supportCoverage = supportOverlap / supportTokens.size` (true coverage), or divide by a meaningful floor like `Math.max(8, supportTokens.size)` — never a cap as low as 3. Three shared generic tokens must NOT yield full support credit.
2. **Strip pure-numeric and date tokens** from BOTH title and raw token sets before scoring: drop tokens matching `^\d+$` (years, months, days, counts) and ISO date fragments. Distinctive words only.
3. **Require distinctive title-token overlap.** A match should need overlap on the *content* title tokens (e.g. `curation`, `orchestrator`), not just dates + generic support. Consider: if `titleOverlap` over the *non-numeric* title tokens is 0, the score is capped low (e.g. ≤ title_threshold-ε) regardless of support/jaccard — no link from support tokens alone.
4. Keep `phraseBonus` (exact title phrase appears in raw) — that's a real signal.

## Task 2 — Honest behavior on the current stub vault

After the fix, with the **current stub embeddings still in place** (degeneracy guard routes to title strategy):
- `memory link-raw --plan` must produce **few, topically-real, or zero** matches — NOT 62 false 1.000s. Per Phase 4.37.1 Stop-and-ask #2, **zero honest anchors is the acceptable answer** on a stub vault. Better 0 than 62 wrong.
- The previously-false targets (`curation-orchestrator-not-llm` ×56) must NOT appear unless the raw genuinely discusses them.

## Task 3 — Verification gate (read the matches, do not trust the count)

This bug slipped through because the count (62, under the 20% backstop) looked acceptable while the matches were garbage. The acceptance is **content**, not count:

1. `link-raw --plan` → for a **sample of 10 emitted matches, read the raw file** and confirm it actually contains the matched page's distinctive title terms (or a clear topical reference). Any 1.000 match to a zero-overlap raw = FAIL.
2. **Negative test (unit):** a raw session sharing only generic + date tokens with a candidate must score **below `title_threshold`** → no link. Use a fixture: raw text with "memory code file 2026 05" vs a candidate titled "2026-05-22-curation-orchestrator-not-llm" with a generic summary → assert score < 0.65 (no match).
3. **Positive test (unit):** a raw session that actually discusses "curation orchestrator" → scores above threshold → links. Proves the fix doesn't kill real matches.
4. Re-run `eval-retrieval` → graph-lift not regressed.

## You will NOT
- Land 4.37/4.37.1 with the saturation bug — it writes false edges at capture time (default-on hook).
- Accept `link-raw --plan` on count alone — read a sample of matched raw files and confirm topical reality.
- Let generic + date token overlap alone produce a link.
- Lower thresholds to "get more matches" — fewer real matches beat many false ones.

## Stop and ask
1. After the fix, `link-raw --plan` on the stub vault yields ~0 matches — confirm that shipping auto-link in a "title-strategy, near-zero until real embeddings" state is acceptable (it is — capture-time safety is the priority; real anchoring arrives when raw embeddings are regenerated with the Voyage key).
2. The numeric-token strip removes a token that's genuinely distinctive in some title (e.g. a version like `v2`) — confirm the strip rule (suggest: strip pure `^\d+$` only, keep alphanumerics like `v2`, `qt6`).

## Acceptance
- `titleMatchScore` no longer returns 1.000 on zero-topical-overlap raw (verified by reading ≥10 sampled `link-raw --plan` matches against their raw content).
- Negative + positive unit tests pass.
- `retrieval.embedding-health` still FAILs on the stub `[1,0,0]` embeddings (4.37.1 check intact).
- Mass-collision backstop + degeneracy guard still pass their tests.
- `eval-retrieval` graph-lift not regressed.
- Full suite + typecheck + build clean.
- Only after this: 4.37 + 4.37.1 + 4.37.2 land together (capture-time auto-link is now safe).

## Commit boundary
- `fix(auto-link): correct title-match scorer — remove support saturation, strip date tokens, require topical overlap (Phase 4.37.2)`

## Grounding
- Verified by reading `link-raw --plan` output (62 matches, `curation-orchestrator-not-llm` ×56 at 1.000) and the matched raw files (curation/orchestrator/compile = 0 mentions). `titleMatchScore` formula read at `src/capture/auto-link.ts:255-284`. `auto_link.enabled: true` default + `post-tool-use.ts:41` calls `autoLinkRawToWiki` at capture time = the reason this is a hard landing blocker.
- This is the session's verify-before-claim catch (again): the fix's own fallback was broken; reading the matched bytes — not the match count — exposed it.
