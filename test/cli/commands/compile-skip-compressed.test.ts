import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCompile } from "../../../src/cli/commands/compile.js";
import { writeCompileStateFile } from "../../../src/compile/state.js";
import { CURRENT_COMPRESS_VERSION } from "../../../src/facts/compress.js";

const TEMPLATE = [
  "# memory:custom",
  "SCHEMA={{schema_content}}",
  "INDEX={{index_content}}",
  "EXISTING={{existing_pages}}",
  "LOG={{recent_log_lines}}",
  "FILES={{raw_files_list}}",
  "RAW={{raw_content}}",
].join("\n");

describe("compile skips fully-compressed files", () => {
  let root: string;
  let origMemRoot: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-skip-compressed-"));
    origMemRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = root;
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw"), { recursive: true });
    await mkdir(join(root, "wiki"), { recursive: true });
    await mkdir(join(root, "var", "compile"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    if (origMemRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMemRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("skips a raw file whose current-version compressed watermark covers its full size", async () => {
    const rawContent = "---\nsource: test\n---\nSome observation content here.";
    await writeFile(join(root, "raw", "session-a.md"), rawContent);

    await writeCompileStateFile(root, {
      consumed: {},
      compressed: {
        "raw/session-a.md": {
          bytes: Buffer.byteLength(rawContent),
          compressVersion: CURRENT_COMPRESS_VERSION,
        },
      },
    });

    const result = await runCompile({
      vaultRoot: root,
      plan: true,
      since: "1970-01-01",
    });

    const skipped = result.rawFilesSkipped?.find(
      (s: { path: string; reason: string }) =>
        s.path.replace(/\\/g, "/").includes("raw/session-a.md"),
    );
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toContain("compress");
  });

  it("does NOT let a stale compress watermark (wrong mtime) suppress a since-edited raw", async () => {
    const rawContent = "---\nsource: test\n---\nEdited observation content!";
    await writeFile(join(root, "raw", "session-edited.md"), rawContent);

    // A current-version, full-size compress watermark whose recorded mtime does
    // NOT match the live file — i.e. the raw was edited after compression.
    await writeCompileStateFile(root, {
      consumed: {},
      compressed: {
        "raw/session-edited.md": {
          bytes: Buffer.byteLength(rawContent),
          compressVersion: CURRENT_COMPRESS_VERSION,
          mtimeMs: 1,
          sourceHash: "stale-hash-of-the-pre-edit-content",
        },
      },
    });

    const result = await runCompile({ vaultRoot: root, plan: true, since: "1970-01-01" });

    const skipped = result.rawFilesSkipped?.find(
      (s: { path: string; reason: string }) =>
        s.path.replace(/\\/g, "/").includes("raw/session-edited.md"),
    );
    expect(skipped?.reason ?? "").not.toContain("compress"); // compile must process it, not suppress
  });

  it("re-compiles a file whose compressed watermark is a stale (older) version", async () => {
    // The old sampling compressor (v2) marked files 'complete' after sampling
    // only a few chunks; a stale-version watermark must NOT suppress compile, so
    // the un-sampled content is recovered by the compile path.
    const rawContent = "---\nsource: test\n---\nSome observation content here.";
    await writeFile(join(root, "raw", "session-stale.md"), rawContent);

    await writeCompileStateFile(root, {
      consumed: {},
      compressed: {
        "raw/session-stale.md": {
          bytes: Buffer.byteLength(rawContent),
          compressVersion: CURRENT_COMPRESS_VERSION - 1,
        },
      },
    });

    const result = await runCompile({ vaultRoot: root, plan: true, since: "1970-01-01" });

    const skipped = result.rawFilesSkipped?.find(
      (s: { path: string; reason: string }) =>
        s.path.replace(/\\/g, "/").includes("raw/session-stale.md"),
    );
    expect(skipped?.reason ?? "").not.toContain("compress");
  });

  it("still includes a file whose compressed watermark is partial", async () => {
    const rawContent =
      "---\nsource: test\n---\nSome observation content.\nNew content appended.";
    await writeFile(join(root, "raw", "session-b.md"), rawContent);

    await writeCompileStateFile(root, {
      consumed: {},
      compressed: {
        "raw/session-b.md": {
          bytes: 10,
          compressVersion: 1,
        },
      },
    });

    const result = await runCompile({
      vaultRoot: root,
      plan: true,
      since: "1970-01-01",
    });

    const skipped = result.rawFilesSkipped?.find(
      (s: { path: string; reason: string }) =>
        s.path.replace(/\\/g, "/").includes("raw/session-b.md"),
    );
    expect(skipped).toBeUndefined();
  });
});
