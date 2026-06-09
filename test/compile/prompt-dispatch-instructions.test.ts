import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("compile prompt template", () => {
  it("documents dispute_page operation kind", async () => {
    const template = await readFile(
      join(__dirname, "../../templates/prompts/compile.md"),
      "utf-8",
    );
    expect(template).toContain("dispute_page");
    expect(template).toContain("conflicting_page");
  });

  it("documents supersede_page operation kind", async () => {
    const template = await readFile(
      join(__dirname, "../../templates/prompts/compile.md"),
      "utf-8",
    );
    expect(template).toContain("supersede_page");
    expect(template).toContain("old_page");
    expect(template).toContain("valid_to");
  });

  it("warns that DISPUTE/SUPERSEDE are staged for review", async () => {
    const template = await readFile(
      join(__dirname, "../../templates/prompts/compile.md"),
      "utf-8",
    );
    expect(template).toContain("staged for review");
  });
});
