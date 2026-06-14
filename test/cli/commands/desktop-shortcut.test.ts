import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopShortcut } from "../../../src/cli/commands/desktop-shortcut.js";

describe("createDesktopShortcut", () => {
  let tempDir: string;
  let desktop: string;
  let fakeCli: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mf-shortcut-"));
    desktop = join(tempDir, "Desktop");
    mkdirSync(desktop);
    fakeCli = join(tempDir, "cli.mjs");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(fakeCli, "// fake cli", "utf-8"),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a .lnk on Windows", async () => {
    if (process.platform !== "win32") return;
    const result = await createDesktopShortcut({
      platform: "win32",
      homeDir: tempDir,
      cliPath: fakeCli,
    });
    expect(result.created).toBe(true);
    expect(result.path).toContain("Memory Fort.lnk");
    expect(existsSync(result.path)).toBe(true);
  });

  it("creates a .command on macOS", async () => {
    const result = await createDesktopShortcut({
      platform: "darwin",
      homeDir: tempDir,
      cliPath: fakeCli,
    });
    expect(result.created).toBe(true);
    expect(result.path).toContain("Memory Fort.command");
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain("dashboard");
  });

  it("creates a .desktop on Linux", async () => {
    const result = await createDesktopShortcut({
      platform: "linux",
      homeDir: tempDir,
      cliPath: fakeCli,
    });
    expect(result.created).toBe(true);
    expect(result.path).toContain("memory-fort.desktop");
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("[Desktop Entry]");
    expect(content).toContain("Memory Fort");
    expect(content).toContain("dashboard");
  });

  it("returns created=false when Desktop folder missing", async () => {
    await rm(desktop, { recursive: true, force: true });
    const result = await createDesktopShortcut({
      platform: "linux",
      homeDir: tempDir,
      cliPath: fakeCli,
    });
    expect(result.created).toBe(false);
    expect(result.reason).toContain("Desktop folder not found");
  });
});
