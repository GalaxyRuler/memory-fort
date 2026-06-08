import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecretsIntoEnv, readSecretsMeta, writeSecret } from "../../src/storage/secrets.js";

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

async function tmpSecrets(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mf-secrets-"));
  return join(dir, "secrets.json");
}

describe("secrets store", () => {
  it("writes a key then reports present + last4 without leaking the value", async () => {
    const p = await tmpSecrets();
    await writeSecret("VOYAGE_API_KEY", "abcd1234XYZ", p);
    const meta = await readSecretsMeta(p);
    expect(meta["VOYAGE_API_KEY"]).toEqual({ present: true, last4: "4XYZ" });
    expect(JSON.stringify(meta)).not.toContain("abcd1234XYZ");
  });

  it("reports absent keys as present:false", async () => {
    const p = await tmpSecrets();
    const meta = await readSecretsMeta(p);
    expect(meta["OPENAI_API_KEY"]).toEqual({ present: false });
  });

  it("layers file keys UNDER real env vars (env wins)", async () => {
    const p = await tmpSecrets();
    await writeSecret("OPENROUTER_API_KEY", "fromfile", p);
    await writeSecret("OPENAI_API_KEY", "openai-file", p);
    process.env["OPENROUTER_API_KEY"] = "fromenv";
    delete process.env["OPENAI_API_KEY"];
    loadSecretsIntoEnv(p);
    expect(process.env["OPENROUTER_API_KEY"]).toBe("fromenv");   // real env preserved
    expect(process.env["OPENAI_API_KEY"]).toBe("openai-file");   // file fills the gap
  });

  it("refuses to write a secrets file inside the vault", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "mf-vault-"));
    process.env["MEMORY_ROOT"] = vaultRoot;
    const inside = join(vaultRoot, "secrets.json");
    await expect(writeSecret("VOYAGE_API_KEY", "k", inside)).rejects.toThrow(/vault/i);
  });
});
