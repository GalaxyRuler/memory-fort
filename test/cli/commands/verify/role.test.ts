import { existsSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { detectRole } from "../../../../src/cli/commands/verify/role.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);

describe("detectRole", () => {
  beforeEach(() => {
    mockedExistsSync.mockReturnValue(false);
  });

  it("uses MEMORY_ROLE=server as an explicit override", () => {
    expect(detectRole({ MEMORY_ROLE: "server" })).toBe("server");
  });

  it("uses MEMORY_ROLE=operator as an explicit override", () => {
    expect(detectRole({ MEMORY_ROLE: "operator" })).toBe("operator");
  });

  it("accepts uppercase MEMORY_ROLE values", () => {
    expect(detectRole({ MEMORY_ROLE: "SERVER" })).toBe("server");
  });

  it("detects the VPS install root with no operator configs as server", () => {
    expect(detectRole({ MEMORY_INSTALL_ROOT: "/root/memory-system" })).toBe("server");
  });

  it("detects a VPS install root with Codex config present as operator", () => {
    mockedExistsSync.mockImplementation((path) =>
      String(path).endsWith(".codex/config.toml") ||
      String(path).endsWith(".codex\\config.toml")
    );

    expect(detectRole({ MEMORY_INSTALL_ROOT: "/root/memory-system" })).toBe("operator");
  });

  it("detects a non-VPS install root as operator", () => {
    expect(detectRole({ MEMORY_INSTALL_ROOT: "/opt/memory-system" })).toBe("operator");
  });

  it("defaults empty env to operator", () => {
    expect(detectRole({})).toBe("operator");
  });
});
