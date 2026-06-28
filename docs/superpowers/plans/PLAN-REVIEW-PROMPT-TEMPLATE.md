# Plan-review prompt template (for GPT-5.5 Pro)

Standing gate for every Tier-2 (and future) planning round:

**plan → GPT-5.5 Pro review → Claude audits the review (verify, not rubber-stamp) → revise → execute.**

GPT-5.5 Pro **cannot read local files or the private repo**, but **can browse the public web + the public repo** (`github.com/GalaxyRuler/memory-fort`). So: **inline the plan under review**, and **point it at the public repo** to verify the shipped state + dependency repos. Only **4 slots change** per round — everything else is fixed. After GPT replies, Claude verifies the load-bearing claims (versions, platform/license, EOL dates) against primary sources before accepting.

---

## Fixed skeleton (copy, fill the `<<SLOTS>>`)

```
ROLE
You are a staff/principal engineer doing an adversarial review of <<a plan | ONE phase of a plan>>, before any code is written. Be blunt, challenge assumptions, verify against online sources. <<one line on why this plan matters / what it gates>>.

TASK
1. Verdict: is this plan sound, salvageable-with-changes, or wrong?
2. Red-team each decision/task and the sequencing.
3. Find the unstated assumption most likely to blow up in the packaged app.
4. Name the single biggest risk + the cheapest way to prove/disprove it first.
If you can browse, VERIFY the load-bearing claims (versions, platform/arch support, license, EOL dates) and cite with dates. Separate fact / judgment / opinion.

CONTEXT (single-user local-first Electron desktop app, "Memory Fort")
<<2–5 lines: canonical markdown vault (also Obsidian); dashboard HTTP on 127.0.0.1:4410 in a utilityProcess (main supervises); no DB today; what this plan is part of>>

ALREADY VERIFIED (independently — accept these, don't relitigate)
<<bullets of facts already nailed down this project, so GPT doesn't waste the review re-deriving them. e.g. node:sqlite has no FTS5 in Node 22; Electron 35 EOL; sqlite-vector rejected (Elastic License vs GPL-3.0 + no win-arm64); sqlite-vec has no win-arm64 prebuilt; etc.>>

HARD CONSTRAINTS
- Installers: Windows x64 + Windows ARM64, macOS ARM64, Linux x64 (AppImage). Unsigned. NO end-user toolchain (native modules rebuilt in CI).
- Ships tsdown-bundled self-contained .mjs, asar:false, currently ZERO native modules in the Electron bundle.
- GPL-3.0-only. Markdown stays canonical/Obsidian-readable. Single-user, local, privacy-sensitive.

THE PLAN UNDER REVIEW
<<INLINE the full plan (or phase) faithfully — goal, decisions/targets with versions, every task with its acceptance, the gates. This is the bulk. GPT can't read it from disk.>>

REPOSITORY (PUBLIC — verify the SHIPPED state, not the plan)
https://github.com/GalaxyRuler/memory-fort (tag <<latest, e.g. v0.10.14>>). Check: <<the specific files that ground this plan's premises — package.json versions, electron/main.ts, dashboard-service.ts, electron-builder.yml, tsdown.config.js>>. Also verify EXTERNALLY: <<the dependency repos / version schedules / platform-support pages this plan bets on>>.

SEED QUESTIONS (engage explicitly; add your own)
<<6–10 questions aimed at THIS plan's riskiest, least-certain assumptions — version choice, platform gaps, ABI/packaging, sequencing, over/under-engineering, what's missing. Be specific, not generic.>>

OUTPUT (use these headings)
1. Verdict (≤5 sentences).
2. Decision/task-by-task critique: keep / change / drop + reason.
3. Sequencing critique.
4. The unstated assumption most likely to fail in the packaged app.
5. Single biggest risk + cheapest first experiment to settle it.
6. Go / adjust / stop — if adjust, the 2–3 concrete changes.
7. Sources (browsed, with dates) + explicit Assumptions.

Think hard; challenge, don't pad.
```

---

## After GPT replies — Claude's audit checklist (don't skip)
1. **Verify every load-bearing claim** against a primary source before accepting (version numbers, EOL dates, platform/arch prebuilts, license terms). GPT drifts on fast-moving facts — both rounds so far had a stale version or a buried risk.
2. **Separate** what changes the plan (accept + apply) from nice-to-haves (note).
3. **Apply** accepted changes to the plan file; **bank** durable verified facts to memory.
4. **Commit + push** the revised plan; record the round in the commit message.

## Rounds log
- 2026-06-25 — Roadmap plan: caught stale ADR "main process" line; Electron 35 EOL; sqlite-vector license/platform trap. GPT's node:sqlite-first idea failed Claude's verification (no FTS5). → reordered, flipped to sqlite-vec, added Phase 0.
- 2026-06-26 — Phase 0 plan: caught the buried win-arm64 sqlite-vec risk (no prebuilt) → moved to Phase 0.0; system-Node-vitest-is-not-ABI-proof; don't ship 0a publicly; pin exact 42.5.0/26.15.5. → revised Phase 0.
- 2026-06-28 — Phase 0b.3 brief (installed-app probe): GPT-5.5 review held up under verification (no fact drift this round; Claude confirmed `utilityProcess.kill()`=SIGTERM/graceful, `allowLoadingUnsignedLibraries` macOS opt default-false, better-sqlite3 12.11.1 fixes Electron-42 + bundles SQLite 3.53.1). Accepted: run probe in the REAL dashboard-service utilityProcess (not a divergent fork); gate on real installed artifacts only (drop "unpacked"); split into 0b.3a/b/c; ungraceful kill for restart-recovery; 30 MB → advisory; vec0 needs runtime API compat not exact SQLite match; commit-vendored win-arm64 vec0.dll + provenance manifest; pull runtime-path guard forward; macOS Gatekeeper/quarantine (not lib-validation) is the unsigned first-launch risk, `allowLoadingUnsignedLibraries` is the forward signing escape-hatch. → revised the 0b.3 brief + plan.
