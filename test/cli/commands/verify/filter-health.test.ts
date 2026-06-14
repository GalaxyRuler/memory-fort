import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCompileFilterHealth } from "../../../../src/cli/commands/verify/filter-health.js";
import { writeCompileStateFile } from "../../../../src/compile/state.js";

describe("compile.filter-health verify check", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-filter-health-"));
    await mkdir(join(root, "raw"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips when compile.raw_filter is disabled", async () => {
    await writeFile(join(root, "config.yaml"), "compile:\n  raw_filter: false\n");

    const result = await checkCompileFilterHealth({ vaultRoot: root, now: () => new Date() });

    expect(result).toMatchObject({
      id: "compile.filter-health",
      status: "skip",
    });
  });

  it("passes and reports reduction, stripped classes, and backlog bytes", async () => {
    await writeFile(join(root, "config.yaml"), "compile:\n  raw_filter: true\n");
    await writeFile(join(root, "raw", "a.md"), "processed");
    await writeCompileStateFile(root, {
      consumed: {
        "raw/a.md": { bytes: Buffer.byteLength("processed") },
      },
      lastVerifyBacklogBytes: 0,
      lastFilterStats: {
        bytesIn: 1_000,
        bytesOut: 250,
        rawBytesConsumed: 1_000,
        strippedByClass: {
          "json-fat-field": 600,
          "asset-table": 150,
        },
        runId: "run-1",
        at: "2026-06-14T00:00:00.000Z",
      },
    });

    const result = await checkCompileFilterHealth({ vaultRoot: root, now: () => new Date() });

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("75%");
    expect(result.detail).toContain("json-fat-field: 600 B");
    expect(result.detail).toContain("asset-table: 150 B");
    expect(result.detail).toContain("backlog 0 B");
  });

  it("warns when raw_filter is enabled but reduction is below 20 percent", async () => {
    await writeFile(join(root, "config.yaml"), "compile:\n  raw_filter: true\n");
    await writeCompileStateFile(root, {
      lastFilterStats: {
        bytesIn: 1_000,
        bytesOut: 850,
        rawBytesConsumed: 1_000,
        strippedByClass: {
          "json-fat-field": 150,
        },
        runId: "run-2",
        at: "2026-06-14T00:00:00.000Z",
      },
    });

    const result = await checkCompileFilterHealth({ vaultRoot: root, now: () => new Date() });

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("15%");
  });

  it("warns when backlog grew since the previous verify snapshot", async () => {
    await writeFile(join(root, "config.yaml"), "compile:\n  raw_filter: true\n");
    await writeFile(join(root, "raw", "pending.md"), "x".repeat(100));
    await writeCompileStateFile(root, {
      consumed: {
        "raw/pending.md": { bytes: 0 },
      },
      lastVerifyBacklogBytes: 50,
      lastFilterStats: {
        bytesIn: 1_000,
        bytesOut: 200,
        rawBytesConsumed: 1_000,
        strippedByClass: {
          "json-fat-field": 800,
        },
        runId: "run-3",
        at: "2026-06-14T00:00:00.000Z",
      },
    });

    const result = await checkCompileFilterHealth({ vaultRoot: root, now: () => new Date() });

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("backlog grew");
  });
});
