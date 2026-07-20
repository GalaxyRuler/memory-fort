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

  it("carries the rewrite_page content-conservation hard rules", async () => {
    const template = await readFile(
      join(__dirname, "../../templates/prompts/compile.md"),
      "utf-8",
    );
    // Each rule targets a rejection class observed in a real proposal batch
    // (2026-07-20: 13 of 16 staged rewrites were lossy).
    expect(template).toContain("content-conservation rules");
    expect(template).toContain("Dated sections are history");
    expect(template).toContain("Rule lists stay lists");
    expect(template).toContain("Never re-assert point-in-time snapshots");
    expect(template).toContain("do not silently drop it");
    expect(template).toContain("Shrinking is suspect");
    expect(template).toContain("When in doubt, emit no operation");
  });

  it("warns that DISPUTE/SUPERSEDE are staged for review", async () => {
    const template = await readFile(
      join(__dirname, "../../templates/prompts/compile.md"),
      "utf-8",
    );
    expect(template).toContain("staged for review");
  });
});

describe("missingDatedSections", () => {
  it("flags a deleted or altered dated section and passes verbatim preservation", async () => {
    const { missingDatedSections } = await import("../../src/compile/execute.js");
    const previous = [
      "Intro prose.",
      "",
      "## 2026-07-01 update",
      "",
      "First recorded event.",
      "",
      "## 2026-07-10 update",
      "",
      "Second recorded event.",
      "",
      "## Other section",
      "",
      "Not dated.",
    ].join("\n");

    const preserved = previous + "\n\n## 2026-07-20 update\n\nNew event.";
    expect(missingDatedSections(previous, preserved)).toEqual([]);

    const reworded = previous.replace("Second recorded event.", "A short summary instead.");
    expect(missingDatedSections(previous, reworded)).toEqual(["## 2026-07-10 update"]);

    const deleted = previous.replace("## 2026-07-01 update\n\nFirst recorded event.\n\n", "");
    expect(missingDatedSections(previous, deleted)).toEqual(["## 2026-07-01 update"]);
  });
});
