import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { runCompactRaw } from "../../../src/cli/commands/compact-raw.js";
import { formatToolUseBlock } from "../../../src/hooks/raw-file.js";

describe("runCompactRaw", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compact-raw-"));
    root = join(tmp, ".memory");
    await mkdir(join(root, "raw", "2026-05-21"), { recursive: true });
    await mkdir(join(root, "state"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans reclaimable bytes without rewriting files", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "codex-big.md");
    const original = rawFixture();
    await writeFile(rawPath, original);

    const result = await runCompactRaw({
      vaultRoot: root,
      mode: "plan",
      maxInputBytes: 300,
      maxOutputBytes: 300,
    });

    expect(result.files).toHaveLength(1);
    expect(result.totalBytesReclaimed).toBeGreaterThan(1_000);
    expect(await readFile(rawPath, "utf-8")).toBe(original);
    expect(result.archived).toEqual([]);
  });

  it("applies compaction, archives originals, preserves observation count, and is idempotent", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "codex-big.md");
    const original = rawFixture();
    await writeFile(rawPath, original);
    const commitVaultChange = vi.fn(async () => ({ kind: "committed" as const, commitSha: "abc1234" }));

    const first = await runCompactRaw({
      vaultRoot: root,
      mode: "apply",
      maxInputBytes: 300,
      maxOutputBytes: 300,
      now: new Date("2026-05-31T00:00:00.000Z"),
      commitVaultChange,
    });

    const compacted = await readFile(rawPath, "utf-8");
    expect(Buffer.byteLength(compacted, "utf-8")).toBeLessThan(Buffer.byteLength(original, "utf-8"));
    expect(observationCount(compacted)).toBe(observationCount(original));
    expect(compacted).toContain("input-head");
    expect(compacted).toContain("input-tail");
    expect(compacted).toContain("output-head");
    expect(compacted).toContain("output-tail");
    expect(first.archived).toHaveLength(1);
    expect(existsSync(join(root, "raw", ".compact-archive", "2026-05-31", "2026-05-21", "codex-big.md"))).toBe(true);
    expect(commitVaultChange).toHaveBeenCalledWith(expect.objectContaining({
      memoryRoot: root,
      message: "compact raw observations",
      paths: expect.arrayContaining([
        "raw/2026-05-21/codex-big.md",
        "raw/.compact-archive/2026-05-31/2026-05-21/codex-big.md",
      ]),
    }));

    const second = await runCompactRaw({
      vaultRoot: root,
      mode: "apply",
      maxInputBytes: 300,
      maxOutputBytes: 300,
      now: new Date("2026-05-31T00:00:00.000Z"),
      commitVaultChange,
    });

    expect(second.files).toEqual([]);
    expect(await readFile(rawPath, "utf-8")).toBe(compacted);
  });

  it("clamps consumed watermarks when compaction shortens a raw file below the recorded offset", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "codex-big.md");
    const original = rawFixture();
    await writeFile(rawPath, original);
    await writeFile(join(root, "state", "compile-state.json"), JSON.stringify({
      consumed: {
        "raw/2026-05-21/codex-big.md": {
          bytes: Buffer.byteLength(original, "utf-8") + 1_000,
          lastObservationAt: "2026-05-21T09:00:00.000Z",
        },
      },
    }, null, 2));

    await runCompactRaw({
      vaultRoot: root,
      mode: "apply",
      maxInputBytes: 300,
      maxOutputBytes: 300,
      commitVaultChange: async () => ({ kind: "no-changes" }),
    });

    const compactedSize = Buffer.byteLength(await readFile(rawPath, "utf-8"), "utf-8");
    const state = JSON.parse(await readFile(join(root, "state", "compile-state.json"), "utf-8"));
    expect(state.consumed["raw/2026-05-21/codex-big.md"].bytes).toBe(compactedSize);
  });

  it("remaps consumed watermarks when compaction removes bytes before a non-EOF offset", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "codex-big.md");
    const original = `${rawFixture()}\n${"large tail after the consumed prefix\n".repeat(700)}`;
    const observationMarker = "## [09:02:00] Observation";
    const oldOffset = Buffer.byteLength(original.slice(0, original.indexOf(observationMarker)), "utf-8");
    await writeFile(rawPath, original);
    await writeFile(join(root, "state", "compile-state.json"), JSON.stringify({
      consumed: {
        "raw/2026-05-21/codex-big.md": {
          bytes: oldOffset,
          lastObservationAt: "2026-05-21T09:01:00.000Z",
        },
      },
    }, null, 2));

    await runCompactRaw({
      vaultRoot: root,
      mode: "apply",
      maxInputBytes: 300,
      maxOutputBytes: 300,
      commitVaultChange: async () => ({ kind: "no-changes" }),
    });

    const compacted = await readFile(rawPath, "utf-8");
    const expectedOffset = Buffer.byteLength(compacted.slice(0, compacted.indexOf(observationMarker)), "utf-8");
    const compactedSize = Buffer.byteLength(compacted, "utf-8");
    const state = JSON.parse(await readFile(join(root, "state", "compile-state.json"), "utf-8"));
    expect(expectedOffset).toBeLessThan(oldOffset);
    expect(compactedSize).toBeGreaterThan(oldOffset);
    expect(state.consumed["raw/2026-05-21/codex-big.md"].bytes).toBe(expectedOffset);
  });
});

function rawFixture(): string {
  return [
    "---",
    "type: raw-session",
    "source: codex",
    "---",
    "",
    "## [09:00:00] Prompt",
    "",
    "keep me exactly",
    formatToolUseBlock({
      toolName: "apply_patch",
      toolInput: { patch: `input-head-${"x".repeat(5_000)}-input-tail` },
      toolOutput: `output-head-${"y".repeat(5_000)}-output-tail`,
      now: new Date("2026-05-21T09:01:00.000Z"),
      maxInputBytes: 20_000,
      maxOutputBytes: 20_000,
    }),
    "## [09:02:00] Observation",
    "",
    "keep me too",
    "",
  ].join("\n");
}

function observationCount(text: string): number {
  return [...text.matchAll(/^## \[/gm)].length;
}
