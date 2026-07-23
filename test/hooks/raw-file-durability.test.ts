import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBlock, ensureRawSessionFile } from "../../src/hooks/raw-file.js";
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
    const files = await readdir(captureSpoolDir());
    expect(files).toHaveLength(1);
    expect(await readFile(join(captureSpoolDir(), files[0]!), "utf-8")).toContain("spooled-not-unlocked");
  }, 20_000);

  it("drains a crash-left spool exactly once after its event was already merged", async () => {
    const now = new Date(Date.UTC(2026, 6, 23, 4, 1, 0));
    const path = await ensureRawSessionFile({ tool: "codex", sessionId: "crash-session", cwd: "C:/work", now });
    await writeFile(`${path}.lock`, "another process holds this lock", "utf-8");
    await appendBlock({ tool: "codex", sessionId: "crash-session", block: "\n## [04:01:00] Prompt\n\nmerge-once\n", now });
    const [spoolName] = await readdir(captureSpoolDir());
    const event = JSON.parse(await readFile(join(captureSpoolDir(), spoolName!), "utf-8")) as { id: string; hash: string; block: string };

    await writeFile(path, `${await readFile(path, "utf-8")}${event.block}\n<!-- memory-fort-capture id=${event.id} hash=${event.hash} -->\n`);
    await rm(`${path}.lock`);
    await appendBlock({ tool: "codex", sessionId: "next-hook", block: "\n## [04:01:01] Prompt\n\nnext\n", now });

    expect(await readdir(captureSpoolDir())).toEqual([]);
    expect((await readFile(path, "utf-8")).match(/merge-once/g)).toHaveLength(1);
  }, 20_000);
});
