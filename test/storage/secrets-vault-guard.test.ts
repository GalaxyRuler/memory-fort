import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { secretsPath } from "../../src/storage/paths.js";

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

function isOutsideVault(p: string): boolean {
  const vault = resolve(process.env["MEMORY_ROOT"] ?? join(homedir(), ".memory"));
  const rel = relative(vault, resolve(p));
  // Outside if: starts with ".." OR is absolute (different Windows drive)
  return rel.startsWith("..") || isAbsolute(rel);
}

describe("secrets path stays out of the vault", () => {
  it("APPDATA path is outside the vault", () => {
    process.env["APPDATA"] = "C:\\Users\\x\\AppData\\Roaming";
    delete process.env["MEMORY_SECRETS_PATH"];
    expect(isOutsideVault(secretsPath())).toBe(true);
  });
  it("default fallback path is outside the vault", () => {
    delete process.env["APPDATA"];
    delete process.env["MEMORY_SECRETS_PATH"];
    delete process.env["XDG_CONFIG_HOME"];
    expect(isOutsideVault(secretsPath())).toBe(true);
  });
});
