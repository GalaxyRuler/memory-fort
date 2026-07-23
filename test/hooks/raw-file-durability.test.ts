import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBlock, ensureRawSessionFile, getCaptureSpoolStatus } from "../../src/hooks/raw-file.js";
import { captureSpoolDir } from "../../src/storage/paths.js";

describe("durable raw capture", () => {
  let root: string;
  let previousRoot: string | undefined;
  let previousSpool: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memtest-durable-capture-"));
    previousRoot = process.env["MEMORY_ROOT"];
    previousSpool = process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    process.env["MEMORY_ROOT"] = root;
    process.env["MEMORY_CAPTURE_SPOOL_DIR"] = join(root, "installation-state", "capture-spool");
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = previousRoot;
    if (previousSpool === undefined) delete process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    else process.env["MEMORY_CAPTURE_SPOOL_DIR"] = previousSpool;
    await rm(root, { recursive: true, force: true });
  });

  it("spools a capture during real session-lock contention instead of appending unlocked", async () => {
    const now = new Date(Date.UTC(2026, 6, 23, 4, 0, 0));
    const path = await ensureRawSessionFile({
      tool: "codex",
      sessionId: "locked-session",
      cwd: "C:/work",
      now,
    });
    await writeFile(`${path}.lock`, "another process holds this lock", "utf-8");

    await appendBlock({
      tool: "codex",
      sessionId: "locked-session",
      block: "\n## [04:00:00] Prompt\n\nspooled-not-unlocked\n",
      now,
    });

    expect(await readFile(path, "utf-8")).not.toContain("spooled-not-unlocked");
    const files = (await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(await readFile(join(captureSpoolDir(), files[0]!), "utf-8")).toContain("spooled-not-unlocked");
  }, 20_000);

  it("keeps a capture_spooled diagnostic observable after a successful drain", async () => {
    const now = new Date("2026-07-23T04:00:00.000Z");
    const path = await ensureRawSessionFile({
      tool: "codex",
      sessionId: "diagnostic-session",
      cwd: "C:/work",
      now,
    });
    await writeFile(`${path}.lock`, "another process holds this lock", "utf-8");

    await appendBlock({
      tool: "codex",
      sessionId: "diagnostic-session",
      block: "\n## [04:00:00] Prompt\n\ndiagnostic-payload\n",
      now,
    });
    const [spoolName] = (await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"));
    const event = JSON.parse(await readFile(join(captureSpoolDir(), spoolName!), "utf-8")) as {
      id: string;
      hash: string;
    };
    expect(await getCaptureSpoolStatus(new Date("2026-07-23T04:00:05.000Z"))).toMatchObject({
      pendingEventCount: 1,
      oldestPendingAgeMs: 5_000,
      captureSpooled: [{
        type: "capture_spooled",
        eventId: event.id,
        hash: event.hash,
        createdAt: now.toISOString(),
      }],
    });

    await rm(`${path}.lock`);
    await appendBlock({
      tool: "codex",
      sessionId: "next-hook",
      block: "\n## [04:00:06] Prompt\n\nnext\n",
      now: new Date("2026-07-23T04:00:06.000Z"),
    });

    vi.resetModules();
    const restarted = await import("../../src/hooks/raw-file.js");
    expect(await restarted.getCaptureSpoolStatus()).toMatchObject({
      pendingEventCount: 0,
      oldestPendingAgeMs: null,
      captureSpooled: [expect.objectContaining({ eventId: event.id, hash: event.hash })],
    });
  }, 20_000);

  it("does not count passive malformed-spool status reads as drain failures", async () => {
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "malformed.json"), "not-json", "utf-8");

    const first = await getCaptureSpoolStatus();
    const second = await getCaptureSpoolStatus();

    expect(first.drainFailures).toBe(0);
    expect(second.drainFailures).toBe(0);
  });

  it("exposes capture_spooled for a pending record created by a previous process", async () => {
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "previous-process.json"), JSON.stringify({
      version: 1,
      id: "previous-process-event",
      hash: "previous-process-hash",
      rawPath: join(root, "raw", "capture.md"),
      block: "previous process payload",
      createdAt: "2026-07-23T04:00:00.000Z",
    }), "utf-8");

    expect(await getCaptureSpoolStatus(new Date("2026-07-23T04:00:03.000Z"))).toMatchObject({
      pendingEventCount: 1,
      oldestPendingAgeMs: 3_000,
      captureSpooled: [{
        type: "capture_spooled",
        eventId: "previous-process-event",
        hash: "previous-process-hash",
        createdAt: "2026-07-23T04:00:00.000Z",
      }],
    });
  });

  it("counts one real failed opportunistic drain exactly once", async () => {
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "malformed.json"), "not-json", "utf-8");
    await writeFile(join(captureSpoolDir(), "failed-drain.json"), JSON.stringify({
      version: 1,
      id: "failed-drain-event",
      hash: "failed-drain-hash",
      rawPath: root,
      block: "failed drain payload",
      createdAt: "2026-07-23T04:00:00.000Z",
    }), "utf-8");

    await appendBlock({
      tool: "codex",
      sessionId: "next-hook",
      block: "\n## [04:00:01] Prompt\n\nnext\n",
      now: new Date("2026-07-23T04:00:01.000Z"),
    });

    const first = await getCaptureSpoolStatus();
    const second = await getCaptureSpoolStatus();
    expect(first).toMatchObject({
      pendingEventCount: 1,
      drainFailures: 1,
    });
    expect(second.drainFailures).toBe(1);
  });

  it("drains a crash-left spool exactly once after its event was already merged", async () => {
    const now = new Date(Date.UTC(2026, 6, 23, 4, 1, 0));
    const path = await ensureRawSessionFile({ tool: "codex", sessionId: "crash-session", cwd: "C:/work", now });
    await writeFile(`${path}.lock`, "another process holds this lock", "utf-8");
    await appendBlock({ tool: "codex", sessionId: "crash-session", block: "\n## [04:01:00] Prompt\n\nmerge-once\n", now });
    const [spoolName] = (await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"));
    const event = JSON.parse(await readFile(join(captureSpoolDir(), spoolName!), "utf-8")) as { id: string; hash: string; block: string };

    await writeFile(path, `${await readFile(path, "utf-8")}${event.block}\n<!-- memory-fort-capture id=${event.id} hash=${event.hash} -->\n`);
    await rm(`${path}.lock`);
    await appendBlock({ tool: "codex", sessionId: "next-hook", block: "\n## [04:01:01] Prompt\n\nnext\n", now });

    expect((await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect((await readFile(path, "utf-8")).match(/merge-once/g)).toHaveLength(1);
  }, 20_000);
});
