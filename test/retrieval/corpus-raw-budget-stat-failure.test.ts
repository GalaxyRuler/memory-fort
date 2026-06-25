import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("corpus raw budget stat failures", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("does not admit the entire raw corpus when raw file stat fails", async () => {
    tmp = await mkdtemp(join(tmpdir(), "mf-corpus-stat-fail-"));
    for (let index = 0; index < 5; index += 1) {
      const date = `2026-06-${String(index + 1).padStart(2, "0")}`;
      const dir = join(tmp, "raw", date);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "codex-session.md"), ["---", "source: codex", "---", "", `raw ${index}`, ""].join("\n"));
    }

    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      stat: async (path: string) => {
        if (path.replace(/\\/g, "/").includes("/raw/")) {
          throw new Error("stat denied");
        }
        return actualFs.stat(path);
      },
    }));
    const { loadSearchCorpus } = await import("../../src/retrieval/corpus.js");

    const corpus = await loadSearchCorpus({ vaultRoot: tmp, scope: "raw", maxRawBytes: 1 });

    expect(corpus.rawTruncated).toBe(true);
    expect(corpus.scannedCounts.raw).toBe(5);
    expect(corpus.errors).toHaveLength(1);
    expect(corpus.errors[0]?.path).toBe("raw/2026-06-05/codex-session.md");
  });
});
