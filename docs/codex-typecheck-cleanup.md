# Codex Implementation Brief — Typecheck Cleanup + Pipeline Gate (Phase 4.3.P)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The full-system checkup (2026-05-28) found `npx tsc --noEmit` reports **9 type errors across 6 files** — and they've been silently accumulating because **nothing in the workflow runs a full typecheck**:

- `npm run build` uses `tsdown` (esbuild/rolldown) — fast, transpile-only, no type checking
- `npm run test` uses vitest — runs tests, doesn't typecheck non-test paths
- There is **no `typecheck` script** in `package.json`

So type errors in non-test source accumulate invisibly. The build is green, tests are green, but the types are wrong. None of these errors are in recently-shipped features (4.3.A-O); they're drift in verify/eval/migration code that no test exercises hard enough to catch.

This brief fixes the 9 errors and adds a `typecheck` gate so they can't silently return.

---

## The 9 errors to fix

```
src/cli/commands/verify/compile.ts(17,3)   TS2322  CompileVerifyOptions vs RunCheckOptions: dashboardStatus is 'unknown' not VerifyDashboardStatus
src/cli/commands/verify/compile.ts(66,27)  TS2550  Array.findLast missing — needs lib es2023 (or a manual reverse-find)
src/cli/commands/verify/compile.ts(66,37)  TS7006  parameter 'entry' implicitly any
src/cli/commands/verify/episodic-relations.ts(22,62)  TS2345  RelationMap not assignable to Record<string,string[]> (RelationEdge[] vs string[])
src/cli/commands/verify/search.ts(56,19)   TS7006  parameter 'texts' implicitly any
src/cli/commands/verify/search.ts(65,13)   TS2322  rerank stub returns {index,relevanceScore}[] but RerankResponse needs {ranked, model}
src/eval/longmemeval/download.ts(84,7)     TS2322  LongMemEvalManifest | null not assignable to LongMemEvalManifest
src/eval/longmemeval/runner.ts(137,17)     TS7006  parameter 'texts' implicitly any
src/migration/map-agentmemory.ts(234,5)    TS2345  type 'string' not assignable to EntityType
```

These cluster into themes:
- **Verify-check option/return drift** (compile.ts, episodic-relations.ts, search.ts) — the check signatures expect `RunCheckOptions` with loosely-typed `dashboardStatus: unknown`, and the rerank/embed stub signatures don't match the real `RerankResponse` / embed types. The types drifted when those interfaces gained fields (e.g., `RerankResponse.ranked`, `.model`)
- **Missing lib target** (compile.ts:66) — `Array.findLast` needs `es2023` lib
- **Implicit any** (search.ts:56, runner.ts:137, compile.ts:66) — untyped callback params
- **Nullability** (download.ts:84) — a `| null` value assigned to a non-null type without a guard
- **EntityType narrowing** (map-agentmemory.ts:234) — a raw `string` assigned where the `EntityType` union is required

---

## Scope guard

You will:

### Task 1 — Fix the 9 type errors

- Fix each error at its source with the **minimal correct typing**, not by casting to `any` or `@ts-ignore`:
  - `compile.ts:17` — align the check's options type with `RunCheckOptions`; if `dashboardStatus` is genuinely `unknown` at the registry boundary, narrow it with a type guard inside the check rather than widening the shared type
  - `compile.ts:66` — either bump the `lib` to `es2023` in tsconfig (preferred if no downside) OR replace `.findLast()` with a manual reverse loop; type the `entry` param
  - `episodic-relations.ts:22` — the function expects `Record<string,string[]>` but gets a `RelationMap` (values are `RelationEdge[]`). Adapt the call to map edges to their target strings, or widen the consumer to accept `RelationMap`
  - `search.ts:56,65` — type the `texts` param; fix the rerank stub to return a full `RerankResponse` (`{ ranked, model, ... }`), not the trimmed shape
  - `download.ts:84` — add a null guard before the assignment, or make the target type nullable if null is legitimately possible
  - `runner.ts:137` — type the `texts` param
  - `map-agentmemory.ts:234` — narrow/validate the `type` string to `EntityType` (use the existing entity-type validator if one exists; else a guarded cast with a runtime check)
- Do NOT silence errors with `as any`, `@ts-ignore`, or `@ts-expect-error`. If a fix genuinely requires a cast, use a narrow `as <SpecificType>` with a runtime guard and a comment

### Task 2 — Add the typecheck gate

- Add to `package.json` scripts:
  ```json
  "typecheck": "tsc --noEmit"
  ```
- If there's a CI workflow (`.github/workflows/`), add a `typecheck` step alongside build + test. If there's no CI, note in the PR/commit that `npm run typecheck` should be run before merge
- Confirm `tsconfig.json` `lib`/`target` supports the features the code uses (es2023 if keeping `findLast`)

### Task 3 — Docs

- `docs/ROADMAP.md`: Phase 4.3.P shipped 2026-05-28 — typecheck cleanup + gate
- If there's a CONTRIBUTING or dev-setup doc, note `npm run typecheck` as part of the pre-merge checklist

You will **not**:

- Refactor the verify/eval/migration logic beyond what's needed to fix the types. This is a typing fix, not a feature change
- Suppress errors with `any` / `@ts-ignore` / `@ts-expect-error`
- Change runtime behavior. After this brief, every check/eval/migration does exactly what it did before — it's just correctly typed
- Touch the tsdown build config or switch the build to `tsc`. The build stays fast (tsdown); `tsc --noEmit` is a separate gate that runs in parallel, not the bundler
- Fix type errors in `node_modules` or generated files (`routeTree.gen.ts`)
- Add new dependencies

If fixing a type error reveals an actual runtime bug (e.g., the `download.ts` null case is reachable and would crash), **stop and ask** — that's a real bug fix that deserves its own discussion, not a silent typing patch.

---

## Acceptance contract

1. `npx tsc --noEmit` exits 0 — zero type errors
2. No `as any`, `@ts-ignore`, or `@ts-expect-error` added (grep the diff to confirm)
3. `npm run typecheck` script exists and runs `tsc --noEmit`
4. Runtime behavior unchanged — full test suite still passes (baseline 1039)
5. `npm run build`, `npm run build:ui` still pass
6. `git diff --check` clean

---

## Verification commands

```powershell
cd C:\CodexProjects\memory-system
npm run typecheck          # must exit 0
git diff | Select-String "as any|ts-ignore|ts-expect-error"   # must be empty
npm test                   # baseline still green
```

---

## Commit boundaries

- Task 1: `fix: resolve 9 pre-existing type errors in verify/eval/migration (Phase 4.3.P Task 1)`
- Task 2: `chore: add typecheck npm script + CI gate (Phase 4.3.P Task 2)`
- Task 3: `docs: typecheck gate (Phase 4.3.P Task 3)`

(Task 1 may be split per-file if the fixes are large; keep each commit independently green.)

---

## Out-of-scope follow-ups

- Enabling stricter tsconfig flags (`noUncheckedIndexedAccess`, etc.) — a separate hardening pass once the baseline is clean
- The other checkup findings (entity dedup 4.3.N, compile cadence 4.3.O, /api/health readiness split, errors.log rotation) — separate briefs
