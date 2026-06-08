# Client Toggles & API Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users (a) toggle individual ingest clients off so `memory verify` stops nagging and the dashboard dims that client, and (b) enter/validate provider API keys in the dashboard, stored in a secrets file outside the git-backed vault.

**Architecture:** Feature 1 adds a `skip` verify status + a `clients` boolean map in `config.yaml` (PATCHable via the existing safelist) consulted by the per-client verify checks and a new Settings card. Feature 2 adds a secrets store at an OS config dir (never in the vault), layered *under* `process.env` at startup, with test-then-save endpoints and masked UI fields. The two features are independent and can be built/shipped separately.

**Tech Stack:** TypeScript (Node 20, ESM, `.js` import specifiers), tsdown build, Vitest, React 19 + TanStack Query, Tailwind tokens, js-yaml.

**Config shape note (supersedes the design's nested shape):** clients are stored as a flat boolean map to fit the existing 2-level config-patch safelist:
```yaml
clients:
  claude-code: true
  codex: false
  antigravity: true
  opencoven: true
```
Absent key = enabled (default true).

**Conventions:**
- Run a single test file: `npx vitest run <path> --reporter=dot`
- All new source imports use `.js` specifiers even for `.ts` files (ESM/tsdown).
- Commit after each task. Branch is `main` in the private worktree.

---

## File Structure

**Feature 1 — Client Toggles**
- Modify `src/cli/commands/verify/types.ts` — add `"skip"` to `CheckStatus` + `skip()` helper.
- Modify `src/cli/commands/verify/render.ts` — render `skip` silently, exclude from counts.
- Modify `src/cli/commands/verify.ts` — `overallStatus` + summary counts ignore `skip`.
- Modify `src/storage/config.ts` — `clients` field on `MemoryConfig`, validation, `isClientEnabled()` helper.
- Modify `src/cli/commands/verify/clients.ts` — per-client checks short-circuit to `skip()` when disabled.
- Modify `src/dashboard/config-patch.ts` — safelist `clients.*` + boolean validation.
- Create `src/dashboard-ui/components/ClientsConfigCard.tsx` — toggle UI with dimmed "Off" state.
- Modify `src/dashboard-ui/components/SettingsPage.tsx` — render the new card.

**Feature 2 — API Key Management**
- Modify `src/storage/paths.ts` — `secretsPath()` resolver.
- Create `src/storage/secrets.ts` — load/read-meta/write/layer-into-env.
- Create `test/storage/secrets.test.ts` — store unit tests incl. out-of-vault assertion.
- Modify `scripts/scan-leaks.mjs` test surface via `test/scripts/secrets-path-guard.test.ts` (new) — secrets path is outside vault.
- Create `src/dashboard/secrets-validate.ts` — per-provider `validateKey()`.
- Modify `src/dashboard/server.ts` — `GET`/`PUT /api/secrets` routes.
- Modify `src/cli.ts` and `src/mcp/server.ts` — call `loadSecretsIntoEnv()` at startup.
- Create `src/dashboard-ui/hooks/useSecrets.ts` — query + mutation hooks.
- Modify `src/dashboard-ui/components/EmbedderConfigCard.tsx` + `LLMConfigCard.tsx` — masked key field, test-then-save.

---

# FEATURE 1 — CLIENT TOGGLES

## Task 1: Add `skip` verify status

**Files:**
- Modify: `src/cli/commands/verify/types.ts`
- Test: `test/cli/commands/verify/types.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// test/cli/commands/verify/types.test.ts
import { describe, expect, it } from "vitest";
import { skip } from "../../../../src/cli/commands/verify/types.js";

describe("skip()", () => {
  it("produces a skip-status check result", () => {
    const result = skip("client.codex.capture", "Codex capture is fresh", "client disabled");
    expect(result.status).toBe("skip");
    expect(result.id).toBe("client.codex.capture");
    expect(result.label).toBe("Codex capture is fresh");
    expect(result.detail).toBe("client disabled");
    expect(result.durationMs).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/commands/verify/types.test.ts --reporter=dot`
Expected: FAIL — `skip` is not exported.

- [ ] **Step 3: Implement**

In `src/cli/commands/verify/types.ts`, change line 1:
```typescript
export type CheckStatus = "pass" | "warn" | "fail" | "skip";
```
Add after the `warn()` function (after line 64):
```typescript
export function skip(id: string, label: string, detail?: string): VerifyCheckResult {
  return { id, label, status: "skip", detail, durationMs: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli/commands/verify/types.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/verify/types.ts test/cli/commands/verify/types.test.ts
git commit -m "feat(verify): add neutral skip check status"
```

---

## Task 2: Reporter + overall-status ignore `skip`

**Files:**
- Modify: `src/cli/commands/verify/render.ts:9-32`
- Modify: `src/cli/commands/verify.ts:84,147-150`
- Test: `test/cli/commands/verify/render.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// test/cli/commands/verify/render.test.ts
import { describe, expect, it } from "vitest";
import { formatVerifyResult } from "../../../../src/cli/commands/verify/render.js";

describe("formatVerifyResult skip handling", () => {
  it("renders skip with a neutral marker and excludes it from pass/fail/warn counts", () => {
    const out = formatVerifyResult({
      role: "operator",
      checks: [
        { id: "a", label: "A ok", status: "pass", durationMs: 0 },
        { id: "b", label: "B off", status: "skip", detail: "client disabled", durationMs: 0 },
      ],
      passed: 1,
      // counts below are what render computes/echoes; assert via output text
    } as never);
    expect(out).toContain("B off");
    expect(out).toContain("skipped");
    // skip must NOT be counted as a failure or warning
    expect(out).not.toContain("1 failed");
    expect(out).not.toContain("1 warning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/commands/verify/render.test.ts --reporter=dot`
Expected: FAIL — `skip` not handled (no "skipped" text / wrong marker).

- [ ] **Step 3: Implement**

Read `src/cli/commands/verify/render.ts` first. In the marker map (line ~13) add a `skip` marker and append a skip count to the summary. Replace the marker selection and summary lines so they read:
```typescript
const MARKER: Record<string, string> = {
  pass: "✓",
  warn: "⚠",
  fail: "✗",
  skip: "○",
};
// ...inside the per-check map, use MARKER[check.status] ?? "•"
// For skip lines, append " (skipped)" using check.detail when present.
```
In the summary computation, count skips separately and never fold them into `failed`/`warnings`:
```typescript
const skipped = result.checks.filter((c) => c.status === "skip").length;
// existing passed/failed/warnings counts must filter status explicitly:
const failed = result.checks.filter((c) => c.status === "fail").length;
const warnings = result.checks.filter((c) => c.status === "warn").length;
// append `; ${skipped} skipped` to the summary line when skipped > 0
```
Then in `src/cli/commands/verify.ts`:
- `overallStatus` (lines 147-150) already returns `pass` when no fail/warn — `skip` falls through to `pass`, which is correct. Leave as-is but add an explicit comment: `// skip is neutral: never fail/warn.`
- Summary counts at/around line 84: ensure `failed`/`passed`/`warnings` are computed with explicit `status ===` filters (not `total - failed`). If `passed` is derived as a remainder, change it to `checks.filter((c) => c.status === "pass").length` so skips are not miscounted as passes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli/commands/verify/render.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Run the existing verify suite to catch regressions**

Run: `npx vitest run test/cli/commands/verify --reporter=dot`
Expected: PASS (existing pass/warn/fail rendering unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/verify/render.ts src/cli/commands/verify.ts test/cli/commands/verify/render.test.ts
git commit -m "feat(verify): render skip neutrally and exclude from counts/exit code"
```

---

## Task 3: `clients` config field + `isClientEnabled()`

**Files:**
- Modify: `src/storage/config.ts:6-92` (type), `:125-228` (validation)
- Test: `test/storage/config.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// test/storage/config.test.ts (append these)
import { describe, expect, it } from "vitest";
import { isClientEnabled, validateMemoryConfig } from "../../src/storage/config.js";

describe("client toggles", () => {
  it("defaults to enabled when clients map or key is absent", () => {
    expect(isClientEnabled({}, "codex")).toBe(true);
    expect(isClientEnabled({ clients: {} }, "codex")).toBe(true);
  });

  it("honors an explicit false", () => {
    expect(isClientEnabled({ clients: { codex: false } }, "codex")).toBe(false);
    expect(isClientEnabled({ clients: { codex: false } }, "claude-code")).toBe(true);
  });

  it("warns when a client flag is not a boolean", () => {
    const warnings = validateMemoryConfig({ clients: { codex: "nope" } } as never);
    expect(warnings.some((w) => w.includes("clients.codex"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/storage/config.test.ts --reporter=dot`
Expected: FAIL — `isClientEnabled` not exported; no validation warning.

- [ ] **Step 3: Implement**

In `src/storage/config.ts`, add to the `MemoryConfig` interface (after the `dashboard` block, before `[key: string]: unknown;`):
```typescript
  clients?: Record<string, boolean>;
```
Add to `validateMemoryConfig` (before `return warnings;` at line 227):
```typescript
  const clients = asRecord(config.clients);
  if (config.clients !== undefined && !clients) {
    warnings.push("clients must be an object mapping client id to a boolean");
  }
  for (const [id, value] of Object.entries(clients ?? {})) {
    if (typeof value !== "boolean") {
      warnings.push(`clients.${id} must be a boolean`);
    }
  }
```
Add an exported helper at the end of the file:
```typescript
/** A client is enabled unless config.clients[id] is explicitly false. */
export function isClientEnabled(config: MemoryConfig, id: string): boolean {
  return config.clients?.[id] !== false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/storage/config.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/config.ts test/storage/config.test.ts
git commit -m "feat(config): clients enable/disable map + isClientEnabled helper"
```

---

## Task 4: Per-client verify checks skip when disabled

**Files:**
- Modify: `src/cli/commands/verify/clients.ts` (descriptors at lines 28, 35, 42, 52 claude-code; 59, 66 codex; 76, 90, 97 antigravity; 104 opencoven)
- Test: `test/cli/commands/verify/clients-toggle.test.ts` (create)

The check `run` functions receive `RunCheckOptions` which extends `VerifyCheckContext` (has `vaultRoot`). Load config inside the check and short-circuit. To avoid loading config repeatedly, add a small cached helper in this file.

- [ ] **Step 1: Write the failing test**

```typescript
// test/cli/commands/verify/clients-toggle.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexCaptureCheck } from "../../../../src/cli/commands/verify/clients.js";

async function makeVault(configYaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mf-clients-"));
  await writeFile(join(root, "config.yaml"), configYaml, "utf-8");
  return root;
}

describe("client toggle short-circuits verify", () => {
  it("returns skip for a disabled client instead of running the capture check", async () => {
    const vaultRoot = await makeVault("clients:\n  codex: false\n");
    const result = await codexCaptureCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("skip");
  });

  it("runs normally when the client is enabled (not skip)", async () => {
    const vaultRoot = await makeVault("clients:\n  codex: true\n");
    const result = await codexCaptureCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).not.toBe("skip");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/commands/verify/clients-toggle.test.ts --reporter=dot`
Expected: FAIL — disabled client still runs the capture check (status not `skip`).

- [ ] **Step 3: Implement**

In `src/cli/commands/verify/clients.ts`:

Add imports at the top:
```typescript
import { isClientEnabled, loadMemoryConfig } from "../../../storage/config.js";
import { skip } from "./types.js";
```
Add a helper near the top of the file (after the constants):
```typescript
/** Returns a skip result when the client is toggled off in config.yaml; else null. */
async function skipIfClientDisabled(
  ctx: { vaultRoot: string },
  clientId: string,
  checkId: string,
  label: string,
): Promise<VerifyCheckResult | null> {
  const config = await loadMemoryConfig(ctx.vaultRoot);
  if (isClientEnabled(config, clientId)) return null;
  return skip(checkId, label, `${clientId} is turned off in config.yaml`);
}
```
For each client check `run`, add a guard as the first line. Map check → clientId:
- claude-code checks (`claudeCodeEnabledCheck`, `claudeCodeHookPathsCheck`, `claudeCodeCaptureCheck`, `snifferClaudeCodeBackfillCheck`) → `"claude-code"`
- codex checks (`codexConfigCheck`, `codexCaptureCheck`) → `"codex"`
- antigravity checks (`antigravityConfigCheck`, `snifferAntigravityPluginCheck`, `antigravityCaptureCheck`) → `"antigravity"`
- opencoven (`openCovenReadinessCheck`) → `"opencoven"`

Example for `codexCaptureCheck` (line 66) — change its `run` to:
```typescript
  run: async (ctx) => {
    const off = await skipIfClientDisabled(ctx, "codex", "client.codex.capture", "Codex capture is fresh");
    if (off) return off;
    return checkRecentCapture(ctx, ["codex-"], "client.codex.capture", "codex", {
      staleFailWhen: () => isCodexConfigured(),
      staleFailureSuggestedFix: "restart Codex and run one tool; then rerun `memory verify`",
    });
  },
```
Apply the same `off`-guard pattern to every listed descriptor, using that descriptor's existing `id` and `label`. Do NOT touch the VS Code or Claude Desktop descriptors (not in scope).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli/commands/verify/clients-toggle.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Run the existing clients/verify suites**

Run: `npx vitest run test/cli/commands/verify-each-check.test.ts --reporter=dot`
Expected: PASS (enabled clients behave exactly as before).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/verify/clients.ts test/cli/commands/verify/clients-toggle.test.ts
git commit -m "feat(verify): skip per-client checks when the client is toggled off"
```

---

## Task 5: Allow `clients.*` in the config-patch safelist

**Files:**
- Modify: `src/dashboard/config-patch.ts:59-86` (safelist + top-level keys), `:184-284` (validateValue)
- Test: `test/dashboard/config-patch.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// test/dashboard/config-patch.test.ts (append)
import { describe, expect, it } from "vitest";
import { validateConfigPatch } from "../../src/dashboard/config-patch.js";

describe("clients patch", () => {
  it("accepts a boolean client toggle", () => {
    const v = validateConfigPatch({ clients: { codex: false } });
    expect(v.ok).toBe(true);
  });
  it("rejects a non-boolean client toggle", () => {
    const v = validateConfigPatch({ clients: { codex: "off" } });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.path === "clients.codex")).toBe(true);
  });
  it("rejects an unknown client id", () => {
    const v = validateConfigPatch({ clients: { mystery: true } });
    expect(v.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard/config-patch.test.ts --reporter=dot`
Expected: FAIL — `clients` is "top-level field not in safelist".

- [ ] **Step 3: Implement**

In `src/dashboard/config-patch.ts`:

Add the 4 known client paths to `SAFELISTED_PATHS` (inside the Set, after line 85):
```typescript
  "clients.claude-code",
  "clients.codex",
  "clients.antigravity",
  "clients.opencoven",
```
Add `"clients"` to `VALID_TOP_LEVEL_KEYS` (line 92):
```typescript
const VALID_TOP_LEVEL_KEYS = new Set(["embedder", "llm", "auto_promote", "auto_heal", "compile", "capture", "dashboard", "clients"]);
```
In `validateValue` (before its closing brace at line 284), add:
```typescript
  if (path.startsWith("clients.") && typeof value !== "boolean") {
    errors.push({ path, message: `${path} must be a boolean` });
  }
```
(Unknown client ids like `clients.mystery` are rejected by the existing `SAFELISTED_PATHS` check — no extra code needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dashboard/config-patch.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/config-patch.ts test/dashboard/config-patch.test.ts
git commit -m "feat(config-patch): safelist clients.* boolean toggles"
```

---

## Task 6: Clients toggle UI card

**Files:**
- Create: `src/dashboard-ui/components/ClientsConfigCard.tsx`
- Modify: `src/dashboard-ui/components/SettingsPage.tsx:49-53`
- Test: `test/dashboard-ui/clients-config-card.test.tsx` (create)

The card lists the four toggleable clients. Each row shows the client name + an on/off toggle. When off, the row is dimmed (`opacity-50`) with an "Off" badge. Toggling calls `useUpdateConfig().mutate({ clients: { [id]: next } })`. Read current state from `useConfig()` (`config.data.clients`).

- [ ] **Step 1: Write the failing test**

```tsx
// test/dashboard-ui/clients-config-card.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClientsConfigCard } from "../../src/dashboard-ui/components/ClientsConfigCard.js";

vi.mock("../../src/dashboard-ui/hooks/useConfig.js", () => ({
  useConfig: () => ({ data: { clients: { codex: false } } }),
}));
vi.mock("../../src/dashboard-ui/hooks/useUpdateConfig.js", () => ({
  useUpdateConfig: () => ({ mutate: vi.fn(), isPending: false }),
}));

function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("ClientsConfigCard", () => {
  it("renders a row per client and marks a disabled client Off + dimmed", () => {
    wrap(<ClientsConfigCard />);
    expect(screen.getByText(/codex/i)).toBeInTheDocument();
    const offBadge = screen.getByText(/^off$/i);
    expect(offBadge).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard-ui/clients-config-card.test.tsx --reporter=dot`
Expected: FAIL — module `ClientsConfigCard` does not exist.

- [ ] **Step 3: Implement**

Create `src/dashboard-ui/components/ClientsConfigCard.tsx`:
```tsx
import { useConfig } from "../hooks/useConfig.js";
import { useUpdateConfig } from "../hooks/useUpdateConfig.js";

const TOGGLEABLE_CLIENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "opencoven", label: "OpenCoven" },
];

export function ClientsConfigCard() {
  const config = useConfig();
  const update = useUpdateConfig();
  const clients = (config.data?.clients ?? {}) as Record<string, boolean>;

  return (
    <section className="rounded-lg border border-border-subtle bg-surface p-4">
      <h2 className="text-base font-semibold text-text-primary">Clients</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Turn off clients you don&apos;t use. Disabled clients stop appearing in
        health checks; capture is unaffected.
      </p>
      <ul className="mt-3 space-y-2">
        {TOGGLEABLE_CLIENTS.map(({ id, label }) => {
          const enabled = clients[id] !== false;
          return (
            <li
              key={id}
              className={`flex items-center justify-between rounded-md border border-border-subtle px-3 py-2 transition-opacity ${
                enabled ? "" : "opacity-50"
              }`}
            >
              <span className="flex items-center gap-2 text-sm text-text-primary">
                {label}
                {!enabled ? (
                  <span className="rounded bg-text-muted/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                    Off
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${label} ${enabled ? "enabled" : "disabled"}`}
                disabled={update.isPending}
                className="rounded-md border border-border-subtle px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => update.mutate({ clients: { [id]: !enabled } })}
              >
                {enabled ? "Turn off" : "Turn on"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```
In `src/dashboard-ui/components/SettingsPage.tsx`, import and render the card after `LLMConfigCard` (line 50):
```tsx
import { ClientsConfigCard } from "./ClientsConfigCard.js";
// ...in JSX, after <LLMConfigCard .../>:
<ClientsConfigCard />
```
If `ConfigObject` (the `useConfig` data type) does not already include `clients`, add `clients?: Record<string, boolean>;` to that type (search for where `useConfig` types its response, e.g. `src/dashboard-ui/hooks/useConfig.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dashboard-ui/clients-config-card.test.tsx --reporter=dot`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/dashboard-ui/components/ClientsConfigCard.tsx src/dashboard-ui/components/SettingsPage.tsx src/dashboard-ui/hooks/useConfig.ts test/dashboard-ui/clients-config-card.test.tsx
git commit -m "feat(ui): clients toggle card with dimmed off state"
```

---

# FEATURE 2 — API KEY MANAGEMENT

## Task 7: `secretsPath()` resolver

**Files:**
- Modify: `src/storage/paths.ts`
- Test: `test/storage/secrets-path.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// test/storage/secrets-path.test.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { secretsPath } from "../../src/storage/paths.js";

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

describe("secretsPath", () => {
  it("honors MEMORY_SECRETS_PATH override", () => {
    process.env["MEMORY_SECRETS_PATH"] = "/custom/secrets.json";
    expect(secretsPath()).toBe("/custom/secrets.json");
  });

  it("uses APPDATA on Windows-like env", () => {
    delete process.env["MEMORY_SECRETS_PATH"];
    process.env["APPDATA"] = "C:\\Users\\x\\AppData\\Roaming";
    expect(secretsPath()).toBe(join("C:\\Users\\x\\AppData\\Roaming", "memory-fort", "secrets.json"));
  });

  it("never resolves inside the memory vault", () => {
    delete process.env["MEMORY_SECRETS_PATH"];
    const vault = join(homedir(), ".memory");
    expect(secretsPath().startsWith(vault)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/storage/secrets-path.test.ts --reporter=dot`
Expected: FAIL — `secretsPath` not exported.

- [ ] **Step 3: Implement**

In `src/storage/paths.ts` add (uses existing `homedir`, `join` imports):
```typescript
/**
 * Absolute path to the provider-secrets file. Deliberately OUTSIDE the
 * git-backed vault (~/.memory) so API keys can never be committed/pushed.
 * Priority: $MEMORY_SECRETS_PATH > OS config dir > ~/.config fallback.
 */
export function secretsPath(): string {
  const override = process.env["MEMORY_SECRETS_PATH"];
  if (override && override.trim().length > 0) return override;
  const appData = process.env["APPDATA"]; // Windows
  if (appData) return join(appData, "memory-fort", "secrets.json");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "memory-fort", "secrets.json");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.trim().length > 0) return join(xdg, "memory-fort", "secrets.json");
  return join(homedir(), ".config", "memory-fort", "secrets.json");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/storage/secrets-path.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/paths.ts test/storage/secrets-path.test.ts
git commit -m "feat(secrets): OS-config-dir secretsPath resolver outside the vault"
```

---

## Task 8: Secrets store (read meta, write, layer into env)

**Files:**
- Create: `src/storage/secrets.ts`
- Test: `test/storage/secrets.test.ts` (create)

Known key names (the complete provider set found in the codebase): `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/storage/secrets.test.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecretsIntoEnv, readSecretsMeta, writeSecret } from "../../src/storage/secrets.js";

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

async function tmpSecrets(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mf-secrets-"));
  return join(dir, "secrets.json");
}

describe("secrets store", () => {
  it("writes a key then reports present + last4 without leaking the value", async () => {
    const p = await tmpSecrets();
    await writeSecret("VOYAGE_API_KEY", "abcd1234XYZ", p);
    const meta = await readSecretsMeta(p);
    expect(meta["VOYAGE_API_KEY"]).toEqual({ present: true, last4: "1XYZ" });
    expect(JSON.stringify(meta)).not.toContain("abcd1234XYZ");
  });

  it("reports absent keys as present:false", async () => {
    const p = await tmpSecrets();
    const meta = await readSecretsMeta(p);
    expect(meta["OPENAI_API_KEY"]).toEqual({ present: false });
  });

  it("layers file keys UNDER real env vars (env wins)", async () => {
    const p = await tmpSecrets();
    await writeSecret("OPENROUTER_API_KEY", "fromfile", p);
    process.env["OPENROUTER_API_KEY"] = "fromenv";
    delete process.env["OPENAI_API_KEY"];
    await writeSecret("OPENAI_API_KEY", "openai-file", p);
    loadSecretsIntoEnv(p);
    expect(process.env["OPENROUTER_API_KEY"]).toBe("fromenv");   // real env preserved
    expect(process.env["OPENAI_API_KEY"]).toBe("openai-file");   // file fills the gap
  });

  it("refuses to write a secrets file inside the vault", async () => {
    const vaultSecrets = join(process.env["MEMORY_ROOT"] ?? join(tmpdir(), "x"), ".memory", "secrets.json");
    process.env["MEMORY_ROOT"] = join(tmpdir(), "vault-guard");
    const inside = join(process.env["MEMORY_ROOT"], "secrets.json");
    await expect(writeSecret("VOYAGE_API_KEY", "k", inside)).rejects.toThrow(/inside the vault/i);
    void vaultSecrets;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/storage/secrets.test.ts --reporter=dot`
Expected: FAIL — `src/storage/secrets.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/storage/secrets.ts`:
```typescript
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { memoryRoot } from "./paths.js";

export const SECRET_KEYS = ["VOYAGE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export interface SecretMeta {
  present: boolean;
  last4?: string;
}

function isInsideVault(filePath: string): boolean {
  const rel = relative(resolve(memoryRoot()), resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !resolve(filePath).includes("\0") && !rel.startsWith(".."));
}

function readRaw(filePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Read presence + last 4 chars per known key. Never returns full secrets. */
export async function readSecretsMeta(filePath: string): Promise<Record<string, SecretMeta>> {
  const raw = readRaw(filePath);
  const meta: Record<string, SecretMeta> = {};
  for (const key of SECRET_KEYS) {
    const val = typeof raw[key] === "string" ? raw[key].trim() : "";
    meta[key] = val ? { present: true, last4: val.slice(-4) } : { present: false };
  }
  return meta;
}

/** Persist one secret. Refuses to write inside the vault. chmod 0600 where supported. */
export async function writeSecret(key: string, value: string, filePath: string): Promise<void> {
  if (isInsideVault(filePath)) {
    throw new Error(`refusing to write secrets inside the vault: ${filePath}`);
  }
  const next = { ...readRaw(filePath), [key]: value };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** Layer secrets-file values UNDER process.env (real env vars always win). */
export function loadSecretsIntoEnv(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // best-effort; reading below is what matters
  }
  const raw = readRaw(filePath);
  for (const key of SECRET_KEYS) {
    const val = typeof raw[key] === "string" ? raw[key].trim() : "";
    if (val && (process.env[key] === undefined || process.env[key] === "")) {
      process.env[key] = val;
    }
  }
}
```
Note: simplify `isInsideVault` to the clear form:
```typescript
function isInsideVault(filePath: string): boolean {
  const rel = relative(resolve(memoryRoot()), resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${require("node:path").sep}`));
}
```
Since this is ESM, do not use `require`. Use:
```typescript
import { relative, resolve, sep } from "node:path";
function isInsideVault(filePath: string): boolean {
  const rel = relative(resolve(memoryRoot()), resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !rel.startsWith(".."));
}
```
Final, canonical implementation of `isInsideVault` (use exactly this):
```typescript
import { relative, resolve, isAbsolute } from "node:path";
function isInsideVault(filePath: string): boolean {
  const rel = relative(resolve(memoryRoot()), resolve(filePath));
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/storage/secrets.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/secrets.ts test/storage/secrets.test.ts
git commit -m "feat(secrets): store with present/last4 meta, 0600 write, env layering, vault guard"
```

---

## Task 9: scan-leaks guard — secrets path is outside the vault

**Files:**
- Create: `test/storage/secrets-vault-guard.test.ts`

This is a pure regression guard: it asserts the resolved secrets path can never live under the vault root, across platforms. No production code changes — it locks the security invariant.

- [ ] **Step 1: Write the failing-then-passing guard test**

```typescript
// test/storage/secrets-vault-guard.test.ts
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { secretsPath } from "../../src/storage/paths.js";

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

function isOutsideVault(p: string): boolean {
  const vault = resolve(process.env["MEMORY_ROOT"] ?? join(homedir(), ".memory"));
  const rel = relative(vault, resolve(p));
  return rel.startsWith("..") || rel === resolve(p);
}

describe("secrets path stays out of the vault", () => {
  it("APPDATA path is outside the vault", () => {
    process.env["APPDATA"] = "C:\\Users\\x\\AppData\\Roaming";
    delete process.env["MEMORY_SECRETS_PATH"];
    expect(isOutsideVault(secretsPath())).toBe(true);
  });
  it("default fallback path is outside the vault", () => {
    delete process.env["APPDATA"];
    delete process.env["MEMORY_SECRETS_PATH"];
    delete process.env["XDG_CONFIG_HOME"];
    expect(isOutsideVault(secretsPath())).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/storage/secrets-vault-guard.test.ts --reporter=dot`
Expected: PASS (invariant already holds from Task 7).

- [ ] **Step 3: Commit**

```bash
git add test/storage/secrets-vault-guard.test.ts
git commit -m "test(secrets): guard that the secrets path never resolves inside the vault"
```

---

## Task 10: Per-provider key validation

**Files:**
- Create: `src/dashboard/secrets-validate.ts`
- Test: `test/dashboard/secrets-validate.test.ts` (create)

Validation uses the cheapest authenticated endpoint per provider, with an injectable `fetch` for tests:
- Voyage → `POST https://api.voyageai.com/v1/embeddings` `{ input: ["ping"], model: "voyage-3-lite" }`
- OpenAI → `POST https://api.openai.com/v1/embeddings` `{ input: "ping", model: "text-embedding-3-small" }`
- OpenRouter → `GET https://openrouter.ai/api/v1/auth/key` (zero-cost key introspection)

- [ ] **Step 1: Write the failing test**

```typescript
// test/dashboard/secrets-validate.test.ts
import { describe, expect, it, vi } from "vitest";
import { validateKey } from "../../src/dashboard/secrets-validate.js";

function fakeFetch(status: number) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => "" })) as never;
}

describe("validateKey", () => {
  it("returns ok for a 200 from the provider", async () => {
    const r = await validateKey("voyage", "k", fakeFetch(200));
    expect(r.ok).toBe(true);
  });
  it("returns not-ok with a message for 401", async () => {
    const r = await validateKey("openai", "bad", fakeFetch(401));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/invalid|unauthor/i);
  });
  it("rejects an unknown provider", async () => {
    const r = await validateKey("mystery" as never, "k", fakeFetch(200));
    expect(r.ok).toBe(false);
  });
  it("hits the OpenRouter key endpoint with a GET", async () => {
    const f = fakeFetch(200);
    await validateKey("openrouter", "k", f);
    expect(f).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/auth/key",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard/secrets-validate.test.ts --reporter=dot`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/dashboard/secrets-validate.ts`:
```typescript
export type SecretProvider = "voyage" | "openai" | "openrouter";

export interface ValidateResult {
  ok: boolean;
  message?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

interface Probe {
  url: string;
  method: "GET" | "POST";
  headers: (key: string) => Record<string, string>;
  body?: string;
}

const PROBES: Record<SecretProvider, Probe> = {
  voyage: {
    url: "https://api.voyageai.com/v1/embeddings",
    method: "POST",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    body: JSON.stringify({ input: ["ping"], model: "voyage-3-lite" }),
  },
  openai: {
    url: "https://api.openai.com/v1/embeddings",
    method: "POST",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    body: JSON.stringify({ input: "ping", model: "text-embedding-3-small" }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/auth/key",
    method: "GET",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

export async function validateKey(
  provider: SecretProvider,
  key: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ValidateResult> {
  const probe = PROBES[provider];
  if (!probe) return { ok: false, message: `unknown provider: ${provider}` };
  if (!key || key.trim().length === 0) return { ok: false, message: "key is empty" };
  try {
    const res = await fetchImpl(probe.url, {
      method: probe.method,
      headers: probe.headers(key),
      ...(probe.body ? { body: probe.body } : {}),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "invalid or unauthorized API key" };
    }
    return { ok: false, message: `provider returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: `could not reach provider: ${(err as Error).message}` };
  }
}

/** Map a secrets env-var name to its provider probe. */
export function providerForKey(key: string): SecretProvider | null {
  if (key === "VOYAGE_API_KEY") return "voyage";
  if (key === "OPENAI_API_KEY") return "openai";
  if (key === "OPENROUTER_API_KEY") return "openrouter";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dashboard/secrets-validate.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/secrets-validate.ts test/dashboard/secrets-validate.test.ts
git commit -m "feat(secrets): per-provider key validation via cheapest authed probe"
```

---

## Task 11: `GET`/`PUT /api/secrets` endpoints

**Files:**
- Modify: `src/dashboard/server.ts` (add routes near the `/api/config` and `/api/providers` handlers, ~lines 679-966)
- Test: `test/dashboard/server-secrets.test.ts` (create)

`GET /api/secrets` → `readSecretsMeta(secretsPath())`. `PUT /api/secrets` body `{ provider, key }` → `validateKey` → on ok `writeSecret(envVarForProvider, key, secretsPath())`, return `{ ok: true }`; on invalid return `422 { ok:false, error }`. Reuse the same-origin + writable guards used by `PATCH /api/config`. Inject `validateKey`/`secretsPath`/`writeSecret`/`readSecretsMeta` via `ServerOptions` for testability, defaulting to the real ones.

- [ ] **Step 1: Write the failing test**

```typescript
// test/dashboard/server-secrets.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/dashboard/server.js";

async function start(overrides: Record<string, unknown> = {}) {
  const vaultRoot = await mkdtemp(join(tmpdir(), "mf-srv-"));
  const server = await createServer({
    vaultRoot,
    host: "127.0.0.1",
    port: 0,
    secretsPathImpl: () => join(vaultRoot, "..", "secrets.json"),
    validateKeyImpl: async () => ({ ok: true }),
    ...overrides,
  } as never);
  return { server, base: `http://127.0.0.1:${server.port}/memory` };
}

describe("/api/secrets", () => {
  it("GET reports presence + last4, never the full key", async () => {
    const { server, base } = await start({
      readSecretsMetaImpl: async () => ({ VOYAGE_API_KEY: { present: true, last4: "wxyz" } }),
    });
    const res = await fetch(`${base}/api/secrets`);
    const body = await res.json();
    expect(body.VOYAGE_API_KEY).toEqual({ present: true, last4: "wxyz" });
    await server.close();
  });

  it("PUT validates then persists; rejects a bad key with 422", async () => {
    const writeSpy = vi.fn(async () => {});
    const { server, base } = await start({
      validateKeyImpl: async (_p: string, key: string) => ({ ok: key === "good", message: "invalid or unauthorized API key" }),
      writeSecretImpl: writeSpy,
    });
    const ok = await fetch(`${base}/api/secrets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ provider: "voyage", key: "good" }),
    });
    expect(ok.status).toBe(200);
    expect(writeSpy).toHaveBeenCalledWith("VOYAGE_API_KEY", "good", expect.any(String));

    const bad = await fetch(`${base}/api/secrets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ provider: "voyage", key: "nope" }),
    });
    expect(bad.status).toBe(422);
    await server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard/server-secrets.test.ts --reporter=dot`
Expected: FAIL — routes + injectable options don't exist.

- [ ] **Step 3: Implement**

In `src/dashboard/server.ts`:

Add imports:
```typescript
import { readSecretsMeta as defaultReadSecretsMeta, writeSecret as defaultWriteSecret } from "../storage/secrets.js";
import { secretsPath as defaultSecretsPath } from "../storage/paths.js";
import { providerForKey, validateKey as defaultValidateKey, type SecretProvider } from "./secrets-validate.js";
```
Add optional fields to `ServerOptions` (the interface around lines 76-95):
```typescript
  secretsPathImpl?: () => string;
  readSecretsMetaImpl?: (p: string) => Promise<Record<string, { present: boolean; last4?: string }>>;
  writeSecretImpl?: (key: string, value: string, p: string) => Promise<void>;
  validateKeyImpl?: (provider: SecretProvider, key: string) => Promise<{ ok: boolean; message?: string }>;
```
In `createServer`, after the `env`/`config` setup (~line 436), resolve the implementations:
```typescript
  const secretsPathFn = opts.secretsPathImpl ?? defaultSecretsPath;
  const readSecretsMetaFn = opts.readSecretsMetaImpl ?? defaultReadSecretsMeta;
  const writeSecretFn = opts.writeSecretImpl ?? defaultWriteSecret;
  const validateKeyFn = opts.validateKeyImpl ?? defaultValidateKey;
  const PROVIDER_ENV: Record<string, string> = {
    voyage: "VOYAGE_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };
```
Add the route handlers alongside the other `/api/*` handlers (mirror the `PATCH /api/config` structure for guards). GET:
```typescript
    if (method === "GET" && path === "/api/secrets") {
      writeJson(res, await readSecretsMetaFn(secretsPathFn()));
      return;
    }
```
PUT:
```typescript
    if (method === "PUT" && path === "/api/secrets") {
      const policy = await loadDashboardOriginPolicy(opts.vaultRoot);
      if (!sameOriginAllowed(req.headers.origin, url, req.headers, policy.trustedOrigins, policy.trustForwardedHeaders, req.socket.remoteAddress)) {
        writeJson(res, { ok: false, error: "cross-origin secret updates are not allowed" }, 403);
        return;
      }
      if (!writeCapability.writable) {
        writeJson(res, { ok: false, error: writeCapability.reason }, 403);
        return;
      }
      try {
        const body = (await readJsonBody(req)) as { provider?: string; key?: string };
        const provider = body.provider as SecretProvider | undefined;
        const envVar = provider ? PROVIDER_ENV[provider] : undefined;
        if (!provider || !envVar || typeof body.key !== "string" || body.key.trim().length === 0) {
          writeJson(res, { ok: false, error: "provider and key are required" }, 400);
          return;
        }
        const verdict = await validateKeyFn(provider, body.key);
        if (!verdict.ok) {
          writeJson(res, { ok: false, error: verdict.message ?? "key validation failed" }, 422);
          return;
        }
        await writeSecretFn(envVar, body.key, secretsPathFn());
        writeJson(res, { ok: true });
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) { writeRequestBodyTooLarge(res); return; }
        if (err instanceof InvalidJsonBodyError) { writeInvalidJsonBody(res); return; }
        writeJson(res, { ok: false, error: (err as Error).message }, 500);
      }
      return;
    }
```
`providerForKey` import is unused here — remove it if the linter complains, or keep PROVIDER_ENV only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dashboard/server-secrets.test.ts --reporter=dot`
Expected: PASS

- [ ] **Step 5: Run the broader server suite**

Run: `npx vitest run test/dashboard/server.test.ts --reporter=dot`
Expected: PASS (no regressions in existing routes/headers).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/server.ts test/dashboard/server-secrets.test.ts
git commit -m "feat(secrets): GET/PUT /api/secrets with validate-then-save, no key echo"
```

---

## Task 12: Startup wiring — layer secrets into env

**Files:**
- Modify: `src/cli.ts` (top-level, before command registration ~line 85-94)
- Modify: `src/mcp/server.ts` (top of bootstrap, before any client/embedder construction)
- Test: `test/storage/secrets.test.ts` already covers `loadSecretsIntoEnv`; add a tiny smoke test for the CLI wiring is optional and skipped (entrypoint side-effect).

- [ ] **Step 1: Implement CLI wiring**

In `src/cli.ts`, add near the other imports:
```typescript
import { loadSecretsIntoEnv } from "./storage/secrets.js";
import { secretsPath } from "./storage/paths.js";
```
Add a single call BEFORE command registration (before `registerDashboardCommand(program)`):
```typescript
// Layer provider keys from the out-of-vault secrets file UNDER real env vars
// so dashboard-entered keys are available to every CLI command. Real env wins.
loadSecretsIntoEnv(secretsPath());
```

- [ ] **Step 2: Implement MCP wiring**

In `src/mcp/server.ts`, add the same import + call at the very start of the server bootstrap (before any embedder/LLM/search runtime is constructed). Place the call as the first statement of the bootstrap function (or top-level if the module self-starts):
```typescript
import { loadSecretsIntoEnv } from "../storage/secrets.js";
import { secretsPath } from "../storage/paths.js";
// ...at bootstrap start:
loadSecretsIntoEnv(secretsPath());
```

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts src/mcp/server.ts
git commit -m "feat(secrets): layer secrets file into env at CLI + MCP startup"
```

---

## Task 13: API-key UI on Embedder + LLM cards

**Files:**
- Create: `src/dashboard-ui/hooks/useSecrets.ts`
- Modify: `src/dashboard-ui/components/EmbedderConfigCard.tsx`
- Modify: `src/dashboard-ui/components/LLMConfigCard.tsx`
- Create: `src/dashboard-ui/components/ApiKeyField.tsx` (shared, DRY across both cards)
- Test: `test/dashboard-ui/api-key-field.test.tsx` (create)

A shared `ApiKeyField` avoids duplicating the masked/reveal/test-then-save logic in two cards.

- [ ] **Step 1: Write the failing test**

```tsx
// test/dashboard-ui/api-key-field.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyField } from "../../src/dashboard-ui/components/ApiKeyField.js";

const mutate = vi.fn();
vi.mock("../../src/dashboard-ui/hooks/useSecrets.js", () => ({
  useSecrets: () => ({ data: { VOYAGE_API_KEY: { present: true, last4: "wxyz" } } }),
  useUpdateSecret: () => ({ mutate, isPending: false, error: null }),
}));

function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("ApiKeyField", () => {
  it("shows masked last4 when a key is present", () => {
    wrap(<ApiKeyField provider="voyage" envVar="VOYAGE_API_KEY" label="Voyage API key" />);
    expect(screen.getByText(/wxyz/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replace/i })).toBeInTheDocument();
  });

  it("submits a new key via the mutation", () => {
    wrap(<ApiKeyField provider="openai" envVar="OPENAI_API_KEY" label="OpenAI API key" />);
    fireEvent.change(screen.getByLabelText(/openai api key/i), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));
    expect(mutate).toHaveBeenCalledWith({ provider: "openai", key: "sk-test" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard-ui/api-key-field.test.tsx --reporter=dot`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement the hooks**

Create `src/dashboard-ui/hooks/useSecrets.ts`:
```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "../lib/api.js";

export interface SecretMeta { present: boolean; last4?: string }
export type SecretsResponse = Record<string, SecretMeta>;

export function useSecrets() {
  return useQuery({
    queryKey: ["secrets"],
    queryFn: () => apiGet<SecretsResponse>("/secrets"),
    staleTime: 60_000,
  });
}

export function useUpdateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { provider: string; key: string }) =>
      apiPut<{ ok: true }>("/secrets", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["secrets"] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
```
If `apiPut` does not exist in `src/dashboard-ui/lib/api.ts`, add it next to `apiPatch` (identical except `method: "PUT"`):
```typescript
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = res.statusText;
    try { const j = await res.json(); message = j.error ?? message; } catch { /* ignore */ }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}
```

- [ ] **Step 4: Implement the shared field**

Create `src/dashboard-ui/components/ApiKeyField.tsx`:
```tsx
import { useState } from "react";
import { useSecrets, useUpdateSecret } from "../hooks/useSecrets.js";

export function ApiKeyField({
  provider,
  envVar,
  label,
}: {
  provider: string;
  envVar: string;
  label: string;
}) {
  const secrets = useSecrets();
  const update = useUpdateSecret();
  const meta = secrets.data?.[envVar];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  const present = meta?.present === true;
  const showInput = editing || !present;

  function submit() {
    if (value.trim().length === 0) return;
    update.mutate(
      { provider, key: value.trim() },
      { onSuccess: () => { setEditing(false); setValue(""); setReveal(false); } },
    );
  }

  return (
    <div className="mt-3">
      <label className="block text-xs font-medium text-text-secondary" htmlFor={`key-${envVar}`}>
        {label}
      </label>
      {showInput ? (
        <div className="mt-1 flex items-center gap-2">
          <input
            id={`key-${envVar}`}
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${label}`}
            className="flex-1 rounded-md border border-border-subtle bg-background px-2 py-1 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <button type="button" className="text-xs text-text-muted hover:text-text-primary" onClick={() => setReveal((r) => !r)}>
            {reveal ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            disabled={update.isPending || value.trim().length === 0}
            className="rounded-md border border-border-subtle px-3 py-1 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
            onClick={submit}
          >
            {update.isPending ? "Validating…" : "Save key"}
          </button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-sm">
          <span className="font-mono text-text-primary">{"•".repeat(8)}{meta?.last4}</span>
          <button type="button" className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary" onClick={() => setEditing(true)}>
            Replace
          </button>
        </div>
      )}
      {update.error ? (
        <p className="mt-1 text-xs text-status-red">{(update.error as Error).message}</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Wire the field into both cards**

In `src/dashboard-ui/components/EmbedderConfigCard.tsx`, import and render the field, choosing the env var by the active provider (only voyage/openai need keys):
```tsx
import { ApiKeyField } from "./ApiKeyField.js";
// ...inside the card body, after the provider/model controls:
{draft.provider === "voyage" ? (
  <ApiKeyField provider="voyage" envVar="VOYAGE_API_KEY" label="Voyage API key" />
) : null}
{draft.provider === "openai" ? (
  <ApiKeyField provider="openai" envVar="OPENAI_API_KEY" label="OpenAI API key" />
) : null}
```
In `src/dashboard-ui/components/LLMConfigCard.tsx`:
```tsx
import { ApiKeyField } from "./ApiKeyField.js";
// ...after the provider/model/token controls:
{draft.provider === "openrouter" ? (
  <ApiKeyField provider="openrouter" envVar="OPENROUTER_API_KEY" label="OpenRouter API key" />
) : null}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/dashboard-ui/api-key-field.test.tsx --reporter=dot`
Expected: PASS

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add src/dashboard-ui/hooks/useSecrets.ts src/dashboard-ui/components/ApiKeyField.tsx src/dashboard-ui/components/EmbedderConfigCard.tsx src/dashboard-ui/components/LLMConfigCard.tsx src/dashboard-ui/lib/api.ts test/dashboard-ui/api-key-field.test.tsx
git commit -m "feat(ui): masked API key field with test-then-save on embedder + llm cards"
```

---

## Final Verification (after all tasks)

- [ ] **Type-check:** `npx tsc --noEmit` → exit 0
- [ ] **Full build:** `npm run build:all` → succeeds
- [ ] **Full suite:** `npx vitest run --reporter=dot` → only the known CPU-load flakes (verify-each-check / connect) may time out under contention; re-run those isolated to confirm green:
  `npx vitest run test/cli/commands/verify-each-check.test.ts test/cli/commands/connect.test.ts --reporter=dot`
- [ ] **Manual smoke (dashboard):** start `node dist/cli.mjs dashboard serve` against an **isolated seed vault** (never the real `~/.memory` without authorization); confirm: Clients card toggles persist + dim; entering a bad key shows the 422 error; a valid key shows masked last4.

---

## Self-Review

**Spec coverage:**
- Client toggle = silence verify + dark card → Tasks 1–6. ✓
- Default enabled when absent → Task 3 `isClientEnabled`. ✓
- Capture untouched → only verify checks + UI touched; no ingest path changes. ✓
- Secrets outside vault, OS dir, 0600 → Tasks 7, 8. ✓
- Env-over-file precedence → Task 8 `loadSecretsIntoEnv`. ✓
- Test-then-save + masked display → Tasks 10, 13. ✓
- GET/PUT never echo full key → Task 11 (`readSecretsMeta` meta-only; PUT returns `{ok}`). ✓
- scan-leaks guard → Tasks 8 (write guard) + 9 (path guard). ✓
- Startup wiring (CLI + MCP) → Task 12. ✓

**Type consistency:** `SecretProvider` ("voyage"|"openai"|"openrouter") used identically in Tasks 10/11/13; `envVar` names (`VOYAGE_API_KEY`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY`) consistent across store, server PROVIDER_ENV, and UI. `isClientEnabled(config, id)` signature consistent in Tasks 3/4. `skip(id,label,detail)` consistent in Tasks 1/4.

**Known follow-ups (out of scope, logged not silently dropped):**
- Hook entrypoints (`dist/hooks/*.mjs`) that embed during ingest do not call `loadSecretsIntoEnv`; if a public user relies on dashboard-entered keys for ingest-time embedding, add the call there too. Documented as a follow-up, not built here.
- Dimming the client representation in any *non-settings* surface (activity feed `SessionTile`, health view) is not included; the Settings Clients card is the toggle + dimmed surface for v1.
