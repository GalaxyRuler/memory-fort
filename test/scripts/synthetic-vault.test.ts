import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateSyntheticVault } from "../../scripts/synthetic-vault.mjs";

describe("synthetic installed-gate vault", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("generates deterministic content and manifest for identical inputs", async () => {
    const first = await makeTempDir();
    const second = await makeTempDir();
    const opts = {
      targetBytes: 4 * 1024,
      hugeBytes: 1024,
      smallFiles: 3,
      reuse: false,
    };

    await generateSyntheticVault({ ...opts, vaultRoot: first });
    await generateSyntheticVault({ ...opts, vaultRoot: second });

    await expect(readFile(join(first, ".spike-manifest.json"), "utf8")).resolves.toBe(
      await readFile(join(second, ".spike-manifest.json"), "utf8"),
    );
    await expect(fileHash(join(first, "wiki", "small", "00", "note-00000.md"))).resolves.toBe(
      await fileHash(join(second, "wiki", "small", "00", "note-00000.md")),
    );
    await expect(fileHash(join(first, "wiki", "pathological", "pathological-150mb.md"))).resolves.toBe(
      await fileHash(join(second, "wiki", "pathological", "pathological-150mb.md")),
    );
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "memory-synthetic-vault-"));
    tempDirs.push(dir);
    return dir;
  }

  async function fileHash(path: string): Promise<string> {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  }
});
