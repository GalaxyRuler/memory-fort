import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCommitRawsIfDirty } from "../../src/sync/auto-commit-raws.js";
import type { CommandRunner } from "../../src/sync/git-remote.js";

interface RecordedCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

function makeRunner(handler: (call: RecordedCall) => { stdout?: string; stderr?: string; exitCode?: number }) {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = {
    async run(cmd, args, opts) {
      const call = { cmd, args, cwd: opts?.cwd };
      calls.push(call);
      const result = handler(call);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
  return { runner, calls };
}

describe("autoCommitRawsIfDirty", () => {
  it("returns no-dirty-files when git status is empty", async () => {
    const { runner, calls } = makeRunner(() => ({ stdout: "" }));

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toEqual({
      kind: "no-dirty-files",
    });

    expect(calls.map((call) => call.args.join(" "))).toEqual(["status --porcelain -uall"]);
  });

  it("commits when only raw/ is dirty", async () => {
    const { runner, calls } = makeRunner((call) => {
      const args = call.args.join(" ");
      if (args === "status --porcelain -uall") {
        return { stdout: " M raw/2026-05-21/foo.md\n?? raw/2026-05-23/bar.md\n" };
      }
      if (args === "add -- raw/2026-05-21/foo.md raw/2026-05-23/bar.md") return {};
      if (args.startsWith("commit -m")) {
        return { stdout: "[main abc1234] chore: auto-capture 2 vault system file(s)\n" };
      }
      throw new Error(`unexpected command: ${args}`);
    });

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toEqual({
      kind: "committed",
      filesCount: 2,
      commitSha: "abc1234",
    });

    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "status --porcelain -uall",
      "add -- raw/2026-05-21/foo.md raw/2026-05-23/bar.md",
      "commit -m chore: auto-capture 2 vault system file(s)",
    ]);
  });

  it("commits raw files and whitelisted system-managed files together", async () => {
    const { runner, calls } = makeRunner((call) => {
      const args = call.args.join(" ");
      if (args === "status --porcelain -uall") {
        return {
          stdout: [
            " M raw/2026-05-21/foo.md",
            " M log.md",
            " M wiki/.audit/llm-2026-06-05.md",
            " M embeddings/auto-heal.jsonl",
            "",
          ].join("\n"),
        };
      }
      if (args === "add -- raw/2026-05-21/foo.md log.md wiki/.audit/llm-2026-06-05.md embeddings/auto-heal.jsonl") {
        return {};
      }
      if (args.startsWith("commit -m")) {
        return { stdout: "[main abc1234] chore: auto-capture 4 vault system file(s)\n" };
      }
      throw new Error(`unexpected command: ${args}`);
    });

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toEqual({
      kind: "committed",
      filesCount: 4,
      commitSha: "abc1234",
    });

    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "status --porcelain -uall",
      "add -- raw/2026-05-21/foo.md log.md wiki/.audit/llm-2026-06-05.md embeddings/auto-heal.jsonl",
      "commit -m chore: auto-capture 4 vault system file(s)",
    ]);
  });

  it("enumerates untracked whitelisted files instead of collapsed directories", async () => {
    const { runner, calls } = makeRunner((call) => {
      const args = call.args.join(" ");
      if (args === "status --porcelain -uall") {
        return {
          stdout: "?? raw/2026-06-05/codex-smoke.md\n?? wiki/.audit/llm-2026-06-05.md\n",
        };
      }
      if (args === "add -- raw/2026-06-05/codex-smoke.md wiki/.audit/llm-2026-06-05.md") {
        return {};
      }
      if (args.startsWith("commit -m")) {
        return { stdout: "[main abc1234] chore: auto-capture 2 vault system file(s)\n" };
      }
      throw new Error(`unexpected command: ${args}`);
    });

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toMatchObject({
      kind: "committed",
      filesCount: 2,
    });

    expect(calls[0]?.args.join(" ")).toBe("status --porcelain -uall");
  });

  it("skips auto-commit when dirty raw files contain secret-shaped content", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "auto-commit-raw-secret-"));
    try {
      await mkdir(join(tmp, "raw", "2026-06-03"), { recursive: true });
      await writeFile(
        join(tmp, "raw", "2026-06-03", "codex-secret.md"),
        "OPENROUTER_API_KEY=sk-live-secret-material-123456",
      );
      const { runner, calls } = makeRunner((call) => {
        const args = call.args.join(" ");
        if (args === "status --porcelain -uall") {
          return { stdout: "?? raw/2026-06-03/codex-secret.md\n" };
        }
        throw new Error(`unexpected command: ${args}`);
      });

      await expect(autoCommitRawsIfDirty({ memoryRoot: tmp, runner })).resolves.toEqual({
        kind: "skipped-secret-shape",
        secretFiles: ["raw/2026-06-03/codex-secret.md"],
      });

      expect(calls.map((call) => call.args.join(" "))).toEqual(["status --porcelain -uall"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("skips auto-commit when a whitelisted file contains secret-shaped content", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "auto-commit-whitelist-secret-"));
    try {
      await writeFile(
        join(tmp, "log.md"),
        "OPENROUTER_API_KEY=sk-live-secret-material-123456",
      );
      const { runner, calls } = makeRunner((call) => {
        const args = call.args.join(" ");
        if (args === "status --porcelain -uall") {
          return { stdout: " M log.md\n" };
        }
        throw new Error(`unexpected command: ${args}`);
      });

      await expect(autoCommitRawsIfDirty({ memoryRoot: tmp, runner })).resolves.toEqual({
        kind: "skipped-secret-shape",
        secretFiles: ["log.md"],
      });

      expect(calls.map((call) => call.args.join(" "))).toEqual(["status --porcelain -uall"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("commits when wiki/ is dirty (system-managed)", async () => {
    const { runner, calls } = makeRunner((call) => {
      if (call.args[0] === "status") return { stdout: " M wiki/projects/foo.md\n M raw/2026-05-21/foo.md\n" };
      if (call.args[0] === "commit") return { stdout: "[main abc1234] chore: auto-capture 2 vault system file(s)\n" };
      return {};
    });

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toMatchObject({
      kind: "committed",
      filesCount: 2,
    });

    expect(calls.map((call) => call.args[0])).toEqual(["status", "add", "commit"]);
  });

  it("skips when unknown top-level files are dirty", async () => {
    const { runner, calls } = makeRunner(() => ({
      stdout: " M crystals/2026-05-22.md\n M secrets.yaml\n M raw/foo.md\n",
    }));

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toEqual({
      kind: "skipped-non-raw-dirty",
      dirtyNonRawFiles: ["crystals/2026-05-22.md", "secrets.yaml"],
    });

    expect(calls.map((call) => call.args.join(" "))).toEqual(["status --porcelain -uall"]);
  });
});
