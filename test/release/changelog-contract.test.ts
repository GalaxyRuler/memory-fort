import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8"),
) as { version: string };
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8");
const versionHeading = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/;

describe("changelog release contract", () => {
  it("keeps one current package release as the first versioned entry", () => {
    const versionedHeadingLines = changelog
      .split(/\r?\n/)
      .filter((line) => line.startsWith("## ["));
    const parsedHeadings = versionedHeadingLines.map((line) => line.match(versionHeading));

    expect(versionedHeadingLines.length).toBeGreaterThan(0);
    expect(parsedHeadings.every((match) => match !== null)).toBe(true);
    expect(parsedHeadings[0]?.[1]).toBe(packageJson.version);
    expect(parsedHeadings.filter((match) => match?.[1] === packageJson.version)).toHaveLength(1);
  });
});
