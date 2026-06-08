import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { secretsPath } from "../../src/storage/paths.js";

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

describe("secretsPath", () => {
  it("honors MEMORY_SECRETS_PATH override", () => {
    process.env["MEMORY_SECRETS_PATH"] = "/custom/secrets.json";
    expect(secretsPath()).toBe("/custom/secrets.json");
  });

  it("uses APPDATA on Windows-like env", () => {
    delete process.env["MEMORY_SECRETS_PATH"];
    process.env["APPDATA"] = "C:\\Users\\x\\AppData\\Roaming";
    expect(secretsPath()).toBe(join("C:\\Users\\x\\AppData\\Roaming", "memory-fort", "secrets.json"));
  });

  it("never resolves inside the memory vault", () => {
    delete process.env["MEMORY_SECRETS_PATH"];
    const vault = join(homedir(), ".memory");
    expect(secretsPath().startsWith(vault)).toBe(false);
  });
});
