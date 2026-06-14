import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompile } from "../../../src/cli/commands/compile.js";

const TEMPLATE = [
  "# memory:custom",
  "RAW={{raw_content}}",
].join("\n");

describe("runCompile raw filter integration", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-filter-"));
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw", "2026-06-14"), { recursive: true });
    await mkdir(join(root, "wiki"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies the raw filter when explicitly enabled and leaves default behavior unchanged", async () => {
    const dump = "x".repeat(5_000);
    const rawPath = join(root, "raw", "2026-06-14", "session.md");
    await writeFile(rawPath, [
      "## [12:00:00] ToolResult",
      "",
      JSON.stringify({ content: dump }),
      "",
      "## [12:01:00] Prompt",
      "",
      "Always test before pushing.",
      "",
    ].join("\n"));

    const unfiltered = await runCompile({ vaultRoot: root });
    expect(unfiltered.prompt).toContain(dump);

    const filtered = await runCompile({ vaultRoot: root, rawFilter: true });
    expect(filtered.prompt).not.toContain(dump);
    expect(filtered.prompt).toContain("Always test before pushing.");
    expect(filtered.filterStats?.bytesIn).toBeGreaterThan(filtered.filterStats?.bytesOut ?? 0);
  });
});
