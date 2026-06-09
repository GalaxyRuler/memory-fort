import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { applyCompileOperations, type CompileOperation } from "../../src/compile/execute.js";

describe("CompileOperation types", () => {
  it("accepts dispute_page operation", () => {
    const op: CompileOperation = {
      kind: "dispute_page",
      path: "wiki/people/user-location.md",
      conflicting_page: "wiki/people/user-location-new.md",
      reason: "Mutually incompatible claims about user location",
    };
    expect(op.kind).toBe("dispute_page");
    expect(op.path).toBeTruthy();
    expect((op as any).conflicting_page).toBeTruthy();
  });

  it("accepts supersede_page operation", () => {
    const op: CompileOperation = {
      kind: "supersede_page",
      old_page: "wiki/tools/python-version.md",
      new_page: "wiki/tools/python-version.md",
      reason: "Python version upgraded from 3.10 to 3.12",
      valid_to: "2026-06-01",
    };
    expect(op.kind).toBe("supersede_page");
    expect((op as any).old_page).toBeTruthy();
    expect((op as any).valid_to).toBeTruthy();
  });
});

describe("applyCompileOperations — dispute_page", () => {
  it("writes dispute record to compile-proposed/", async () => {
    const vault = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    await mkdir(join(vault, "wiki", "compile-proposed"), { recursive: true });
    await mkdir(join(vault, "wiki", "people"), { recursive: true });

    await writeFile(
      join(vault, "wiki", "people", "user-location.md"),
      "---\ntitle: User Location\ntype: people\nlifecycle: canonical\n---\n\nUser lives in NYC.\n",
    );

    const ops: CompileOperation[] = [
      {
        kind: "dispute_page",
        path: "wiki/people/user-location.md",
        conflicting_page: "wiki/people/user-location-sf.md",
        reason: "User relocated to SF — incompatible with NYC claim",
      },
    ];

    await applyCompileOperations({ vaultRoot: vault, operations: ops });

    const proposed = await readdir(join(vault, "wiki", "compile-proposed"));
    expect(proposed.length).toBeGreaterThan(0);
    expect(proposed.some(f => f.startsWith("dispute-"))).toBe(true);
  });
});

describe("applyCompileOperations — supersede_page", () => {
  it("writes supersede record to compile-proposed/", async () => {
    const vault = await mkdtemp(join(tmpdir(), "dispatch-test-"));
    await mkdir(join(vault, "wiki", "compile-proposed"), { recursive: true });
    await mkdir(join(vault, "wiki", "tools"), { recursive: true });

    await writeFile(
      join(vault, "wiki", "tools", "python-version.md"),
      "---\ntitle: Python Version\ntype: tools\nlifecycle: canonical\n---\n\nProject uses Python 3.10.\n",
    );

    const ops: CompileOperation[] = [
      {
        kind: "supersede_page",
        old_page: "wiki/tools/python-version.md",
        new_page: "wiki/tools/python-version.md",
        reason: "Upgraded to Python 3.12",
        valid_to: "2026-06-01",
      },
    ];

    await applyCompileOperations({ vaultRoot: vault, operations: ops });

    const proposed = await readdir(join(vault, "wiki", "compile-proposed"));
    expect(proposed.length).toBeGreaterThan(0);
    expect(proposed.some(f => f.startsWith("supersede-"))).toBe(true);
  });
});
