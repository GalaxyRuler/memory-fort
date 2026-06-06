import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkUncommittedVault } from "../../../../src/cli/commands/verify/uncommitted-vault.js";
import type { CommandRunner } from "../../../../src/sync/git-remote.js";

describe("checkUncommittedVault", () => {
  let tmp: string;
  const now = () => new Date("2026-05-28T12:00:00.000Z");

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-uncommitted-vault-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes when git reports a clean vault", async () => {
    const runner = fakeRunner("");

    await expect(checkUncommittedVault({ vaultRoot: tmp, now, runner })).resolves.toMatchObject({
      id: "sync.uncommitted-vault",
      status: "pass",
      detail: "vault working tree clean",
    });
  });

  it("warns when uncommitted vault changes are older than the debounce window", async () => {
    await writeVaultFile("wiki/threads/a.md", "old");
    await utimes(join(tmp, "wiki", "threads", "a.md"), now(), new Date("2026-05-28T11:40:00.000Z"));
    const runner = fakeRunner(" M wiki/threads/a.md\n");

    await expect(checkUncommittedVault({ vaultRoot: tmp, now, runner })).resolves.toMatchObject({
      id: "sync.uncommitted-vault",
      status: "warn",
      detail: expect.stringContaining("wiki/threads/a.md"),
      suggestedFix: "run `memory sync` or inspect pending vault mutations",
    });
  });

  it("passes while uncommitted vault changes are still inside the debounce window", async () => {
    await writeVaultFile("wiki/threads/a.md", "recent");
    await utimes(join(tmp, "wiki", "threads", "a.md"), now(), new Date("2026-05-28T11:55:00.000Z"));
    const runner = fakeRunner(" M wiki/threads/a.md\n");

    await expect(checkUncommittedVault({ vaultRoot: tmp, now, runner })).resolves.toMatchObject({
      id: "sync.uncommitted-vault",
      status: "pass",
      detail: "1 uncommitted vault change(s), all younger than 10m",
    });
  });

  async function writeVaultFile(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function fakeRunner(stdout: string): CommandRunner {
  return {
    run: vi.fn(async () => ({ exitCode: 0, stdout, stderr: "" })),
  };
}
