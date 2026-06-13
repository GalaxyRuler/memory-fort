import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCompile } from "../../../src/cli/commands/compile.js";
import { writeCompileStateFile } from "../../../src/compile/state.js";

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

  it("skips a raw file whose compressed watermark covers its full size", async () => {
    const rawContent = "---\nsource: test\n---\nSome observation content here.";
    await writeFile(join(root, "raw", "session-a.md"), rawContent);

    await writeCompileStateFile(root, {
      consumed: {},
      compressed: {
        "raw/session-a.md": {
          bytes: Buffer.byteLength(rawContent),
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
        s.path.replace(/\\/g, "/").includes("raw/session-a.md"),
    );
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toContain("compress");
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
