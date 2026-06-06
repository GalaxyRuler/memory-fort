import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPromptDrift } from "../../../../src/cli/commands/verify/prompt-drift.js";

describe("prompt.drift verify check", () => {
  let tmp: string;
  let root: string;
  let sourceRepoDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "prompt-drift-"));
    root = join(tmp, ".memory");
    sourceRepoDir = join(tmp, "source");
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(sourceRepoDir, "templates", "prompts"), { recursive: true });
    await writeFile(join(sourceRepoDir, "templates", "prompts", "compile.md"), bundled("compile", "current compile"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("warns when a vault prompt differs from its bundled template without a customization marker", async () => {
    await writeFile(join(root, "prompts", "compile.md"), "stale compile\n");

    const result = await checkPromptDrift({ vaultRoot: root, sourceRepoDir });

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("prompts/compile.md");
    expect(result.suggestedFix).toContain("memory sync-prompts --apply");
  });

  it("passes when a differing vault prompt is explicitly customized", async () => {
    await writeFile(join(root, "prompts", "compile.md"), "# memory:custom\ncustom compile\n");

    const result = await checkPromptDrift({ vaultRoot: root, sourceRepoDir });

    expect(result.status).toBe("pass");
  });

  it("passes when the vault prompt matches the bundled template", async () => {
    await writeFile(join(root, "prompts", "compile.md"), bundled("compile", "current compile"));

    const result = await checkPromptDrift({ vaultRoot: root, sourceRepoDir });

    expect(result.status).toBe("pass");
  });
});

function bundled(name: string, body: string): string {
  return `<!-- memory:template ${name}:test -->\n${body}\n`;
}
