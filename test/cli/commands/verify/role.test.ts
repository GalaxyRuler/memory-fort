import { describe, expect, it } from "vitest";
import { detectRole } from "../../../../src/cli/commands/verify/role.js";

describe("detectRole", () => {
  it("uses MEMORY_ROLE=server as an explicit override", () => {
    expect(detectRole({ MEMORY_ROLE: "server" })).toBe("server");
  });

  it("uses MEMORY_ROLE=operator as an explicit override", () => {
    expect(detectRole({ MEMORY_ROLE: "operator" })).toBe("operator");
  });

  it("accepts uppercase MEMORY_ROLE values", () => {
    expect(detectRole({ MEMORY_ROLE: "SERVER" })).toBe("server");
  });

  it("defaults empty env to operator", () => {
    expect(detectRole({})).toBe("operator");
  });
});
