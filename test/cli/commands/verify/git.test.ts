import { describe, expect, it } from "vitest";
import { checkGitDurabilityConfig } from "../../../../src/cli/commands/verify/git.js";

describe("checkGitDurabilityConfig", () => {
  const base = {
    vaultRoot: "/v",
    now: () => new Date("2026-06-17T00:00:00.000Z"),
  };

  it("passes when core.fsync=committed", async () => {
    const execFile = async () => ({ stdout: "committed\n", stderr: "" });

    const r = await checkGitDurabilityConfig({ ...base, execFile });

    expect(r.status).toBe("pass");
  });

  it("warns when core.fsync set to something else", async () => {
    const execFile = async () => ({ stdout: "loose-object\n", stderr: "" });

    const r = await checkGitDurabilityConfig({ ...base, execFile });

    expect(r.status).toBe("warn");
  });

  it("fails when core.fsync unset", async () => {
    const execFile = async () => ({ stdout: "\n", stderr: "" });

    const r = await checkGitDurabilityConfig({ ...base, execFile });

    expect(r.status).toBe("fail");
  });
});
