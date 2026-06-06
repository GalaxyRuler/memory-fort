import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { runWatch } from "../../../src/cli/commands/watch.js";
import type { Closable, RawSession, Sniffer } from "../../../src/sniffers/types.js";

describe("runWatch", () => {
  let tmp: string;
  let memoryDir: string;
  let originalMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-watch-"));
    memoryDir = join(tmp, ".memory");
    originalMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = memoryDir;
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    if (originalMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = originalMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("starts watch-capable sniffers, writes captured sessions, and logs activity", async () => {
    const sniffer = fakeWatchSniffer("claude-desktop", {
      source: "claude-desktop",
      sessionId: "desktop-live",
      startedAt: "2026-05-26T12:00:00.000Z",
      updatedAt: "2026-05-26T12:00:00.000Z",
      body: "## [12:00:00] Prompt\n\nhello from desktop\n",
    });

    const result = await runWatch({
      sniffers: [sniffer],
      once: true,
      now: new Date("2026-05-26T12:00:00.000Z"),
    });

    expect(result.started).toEqual(["claude-desktop"]);
    expect(result.captured).toBe(1);
    const rawPath = join(memoryDir, "raw", "2026-05-26", "claude-desktop-desktop-live.md");
    expect(existsSync(rawPath)).toBe(true);
    expect(await readFile(rawPath, "utf-8")).toContain("hello from desktop");
    const log = await readFile(join(memoryDir, "logs", "watch-2026-05-26.log"), "utf-8");
    expect(log).toContain("started claude-desktop");
    expect(log).toContain("captured claude-desktop desktop-live");
  });

  it("filters clients and skips unavailable or non-watch sniffers", async () => {
    const started: string[] = [];
    const desktop = fakeWatchSniffer("claude-desktop", {
      source: "claude-desktop",
      sessionId: "desktop-live",
      startedAt: "2026-05-26T12:00:00.000Z",
      updatedAt: "2026-05-26T12:00:00.000Z",
      body: "body",
    }, started);
    const claudeCode: Sniffer = {
      name: "claude-code",
      available: async () => true,
      list: async function* () {},
    };

    const result = await runWatch({
      clients: ["claude-desktop"],
      sniffers: [desktop, claudeCode],
      once: true,
      now: new Date("2026-05-26T12:00:00.000Z"),
    });

    expect(started).toEqual(["claude-desktop"]);
    expect(result.skipped).toEqual([]);
  });
});

function fakeWatchSniffer(
  name: string,
  session: RawSession,
  started: string[] = [],
): Sniffer {
  return {
    name,
    available: async () => true,
    list: async function* () {},
    watch(handler: (session: RawSession) => void): Closable {
      started.push(name);
      queueMicrotask(() => handler(session));
      return { close: () => undefined };
    },
  };
}
