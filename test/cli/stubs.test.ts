import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(process.cwd(), "dist", "cli.mjs");

function runStub(
  name: string,
  extraArgs: string[] = [],
): { code: number; stderr: string; stdout: string } {
  const r = spawnSync("node", [CLI, name, ...extraArgs], {
    encoding: "utf-8",
  });
  return {
    code: r.status ?? -1,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? "",
  };
}

describe("stub commands", () => {
  const stubs: Array<[string, number]> = [
    ["search", 3],
    ["compile", 2],
    ["lint", 2],
    ["crystallize", 4],
    ["backup", 6],
    ["page", 2],
    ["import-from-agentmemory", 5],
    ["retain", 6],
    ["schedule", 6],
  ];

  for (const [name, phase] of stubs) {
    it(`'${name}' exits 2 with Phase ${phase} message`, () => {
      const r = runStub(name);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        `memory ${name}: not yet implemented in Phase 1`,
      );
      expect(r.stderr).toContain(`Phase ${phase}`);
    });
  }

  it("stub accepts arbitrary positional args without complaining about unknown options", () => {
    const r = runStub("search", ["some query", "--unknown-flag", "value"]);
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("unknown option");
  });
});
