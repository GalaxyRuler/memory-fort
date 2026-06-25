import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Electron main heap policy", () => {
  it("does not try to raise the already-started main-process heap", async () => {
    const source = await readFile(join(process.cwd(), "electron", "main.ts"), "utf-8");

    expect(source).not.toContain("node:v8");
    expect(source).not.toContain("setFlagsFromString");
    expect(source).not.toContain("appendSwitch(\"js-flags\"");
    expect(source).toContain("main heap is ~4GB-capped; dashboard server work runs in a utility process.");
  });

  it("supervises the dashboard utility process instead of running the HTTP server in main", async () => {
    const source = await readFile(join(process.cwd(), "electron", "main.ts"), "utf-8");

    expect(source).toContain("utilityProcess");
    expect(source).toContain("dashboard-service.mjs");
    expect(source).toContain("createDashboardServiceSupervisor");
    expect(source).not.toContain("runDashboard(");
  });

  it("renders a minimal startup error window when the dashboard service cannot start", async () => {
    const source = await readFile(join(process.cwd(), "electron", "main.ts"), "utf-8");

    expect(source).toContain("dashboard service failed to start");
    expect(source).toContain("createStartupErrorWindow");
    expect(source).toContain("MemoryFort failed to start");
    expect(source).toContain("data:text/html");
  });
});
