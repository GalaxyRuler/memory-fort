import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkerPath } from "../../src/dashboard/worker-paths.js";

// tsdown inlines the dashboard code into BOTH the standalone dist/dashboard/
// server.mjs entry AND the dist/cli.mjs / dist/electron-main.mjs entries, so a
// worker-spawning helper's import.meta.url may sit at dist/ (cli/electron) or
// dist/dashboard/ (server). The worker entries always emit to dist/dashboard/.
// The original `dirname(import.meta.url)/<worker>.mjs` resolved to a nonexistent
// dist/<worker>.mjs from the cli/electron bundles, silently breaking isolation.
describe("resolveWorkerPath", () => {
  async function vaultWithWorker(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wp-"));
    await mkdir(join(root, "dashboard"), { recursive: true });
    await writeFile(join(root, "dashboard", "demo-worker.mjs"), "");
    return root;
  }

  it("resolves the worker from a root-dist caller (cli/electron bundle)", async () => {
    const root = await vaultWithWorker();
    const callerUrl = pathToFileURL(join(root, "electron-main.mjs")).href;
    expect(resolveWorkerPath(callerUrl, "demo-worker.mjs")).toBe(join(root, "dashboard", "demo-worker.mjs"));
  });

  it("resolves the worker from a sibling caller (standalone server bundle)", async () => {
    const root = await vaultWithWorker();
    const callerUrl = pathToFileURL(join(root, "dashboard", "server.mjs")).href;
    expect(resolveWorkerPath(callerUrl, "demo-worker.mjs")).toBe(join(root, "dashboard", "demo-worker.mjs"));
  });

  it("resolves the worker from the dashboard service bundle", async () => {
    const root = await vaultWithWorker();
    const callerUrl = pathToFileURL(join(root, "dashboard", "dashboard-service.mjs")).href;
    expect(resolveWorkerPath(callerUrl, "demo-worker.mjs")).toBe(join(root, "dashboard", "demo-worker.mjs"));
  });
});
