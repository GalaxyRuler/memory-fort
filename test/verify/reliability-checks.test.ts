import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOrphanedTmp } from "../../src/cli/commands/verify/orphaned-tmp.js";
import { checkEmbeddingsIntegrity } from "../../src/cli/commands/verify/embeddings-integrity.js";
import { checkSyncStateDrift } from "../../src/cli/commands/verify/sync-state-drift.js";
import { writeSyncStateFile } from "../../src/sync/status.js";

describe("reliability verify checks", () => {
  let root: string;
  const ctx = () => ({ vaultRoot: root, now: () => new Date() });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-reliability-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // -- orphaned-tmp --

  it("orphaned-tmp passes on a clean vault", async () => {
    expect((await checkOrphanedTmp(ctx())).status).toBe("pass");
  });

  it("orphaned-tmp warns about old .tmp files and ignores fresh ones", async () => {
    await mkdir(join(root, "wiki"), { recursive: true });
    const stale = join(root, "wiki", "page.md.123.456.aaaa.tmp");
    await writeFile(stale, "partial");
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await utimes(stale, twoHoursAgo, twoHoursAgo);
    await writeFile(join(root, "wiki", "fresh.md.1.2.bbbb.tmp"), "in-flight");

    const result = await checkOrphanedTmp(ctx());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("page.md.123.456.aaaa.tmp");
    expect(result.detail).not.toContain("fresh.md");
  });

  // -- embeddings-integrity --

  it("embeddings-integrity passes when files are clean or absent", async () => {
    expect((await checkEmbeddingsIntegrity(ctx())).status).toBe("pass");
  });

  it("embeddings-integrity warns on malformed JSONL lines", async () => {
    await mkdir(join(root, "embeddings"), { recursive: true });
    const content = [
      JSON.stringify({ path: "a.md", hash: "h", vector: [1], model: "m", dim: 1, ts: "t" }),
      "NOT VALID JSON {{{",
      JSON.stringify({ path: "b.md", hash: "h", vector: [2], model: "m", dim: 1, ts: "t" }),
    ].join("\n");
    await writeFile(join(root, "embeddings", "wiki.embeddings.jsonl"), content);

    const result = await checkEmbeddingsIntegrity(ctx());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("wiki:2");
  });

  // -- sync-state-drift --

  it("sync-state-drift warns when state says conflicted but git is clean", async () => {
    await writeSyncStateFile(root, {
      last_sync_attempt: null,
      last_sync_success: null,
      pending_push_count: 0,
      conflicts_pending: 2,
      conflict_files: ["raw/a.md", "raw/b.md"],
    });
    const runner = {
      async run() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const result = await checkSyncStateDrift({ ...ctx(), runner });
    expect(result.status).toBe("warn");
  });

  it("sync-state-drift passes when no conflict is recorded", async () => {
    const result = await checkSyncStateDrift(ctx());
    expect(result.status).toBe("pass");
  });
});
