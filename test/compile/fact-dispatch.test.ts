import { describe, it, expect } from "vitest";
import type { CompileOperation } from "../../src/compile/execute.js";

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
