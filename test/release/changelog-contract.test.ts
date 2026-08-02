import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8"),
) as { version: string };
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8");
const RELEASE_CONTENT_VERSION = "0.13.1";
const semanticVersion = /\b\d+\.\d+\.\d+\b/;
const versionHeading = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/;

function assertChangelogContract(version: string, source: string): void {
  const versionedHeadingLines = source
    .split(/\r?\n/)
    .filter((line) => line.startsWith("## ") && semanticVersion.test(line));

  if (versionedHeadingLines.length === 0) {
    throw new Error("No version headings found");
  }

  const parsedHeadings = versionedHeadingLines.map((line) => {
    const match = line.match(versionHeading);
    if (!match) {
      throw new Error(`Invalid version heading: ${line}`);
    }
    return match;
  });

  if (parsedHeadings[0]?.[1] !== version) {
    throw new Error("The first versioned changelog entry does not match the package version");
  }
  if (parsedHeadings.filter((match) => match[1] === version).length !== 1) {
    throw new Error("The package version must appear exactly once in the changelog");
  }
}

function releaseSubsection(source: string, version: string, heading: string): string {
  const releaseStart = source.indexOf(`## [${version}]`);
  const nextRelease = source.indexOf("\n## [", releaseStart + 1);
  const release = source.slice(releaseStart, nextRelease === -1 ? undefined : nextRelease);
  const sectionStart = release.indexOf(`### ${heading}`);
  const nextSection = release.indexOf("\n### ", sectionStart + 1);
  return release.slice(sectionStart, nextSection === -1 ? undefined : nextSection);
}

describe("changelog release contract", () => {
  it("keeps one current package release as the first versioned entry", () => {
    expect(() => assertChangelogContract(packageJson.version, changelog)).not.toThrow();
  });

  it("records new commands and deprecated retention keys in their release sections", () => {
    const added = releaseSubsection(changelog, RELEASE_CONTENT_VERSION, "Added");
    const deprecated = releaseSubsection(changelog, RELEASE_CONTENT_VERSION, "Deprecated");

    expect(added).toContain("`memory forget`");
    expect(added).toContain("`memory backup`");
    expect(deprecated).toContain("`retention.raw_compile_before_delete`");
    expect(deprecated).toContain("`retention.embeddings_prune_with_raw`");
    expect(deprecated).toContain("`retention.crystals_never_auto_delete`");
    expect(deprecated).toContain("`retention.archive_before_delete`");
  });

  it.each([
    ["unbracketed", "## 0.13.1 - 2026-07-27"],
    ["missing separator", "## [0.13.1] 2026-07-27"],
  ])("rejects a %s semantic-version heading", (_name, heading) => {
    expect(() => assertChangelogContract("0.13.1", heading)).toThrow("Invalid version heading");
  });

  it("ignores ordinary level-two headings", () => {
    const fixture = [
      "## Unreleased",
      "## Notes for maintainers",
      "## [0.13.1] - 2026-07-27",
      "## [0.13.0] - 2026-07-21",
    ].join("\n");

    expect(() => assertChangelogContract("0.13.1", fixture)).not.toThrow();
  });

  it.each([
    ["missing", "## [0.13.0] - 2026-07-21"],
    [
      "displaced",
      ["## [0.13.0] - 2026-07-21", "## [0.13.1] - 2026-07-27"].join("\n"),
    ],
    [
      "duplicated",
      ["## [0.13.1] - 2026-07-27", "## [0.13.1] - 2026-07-26"].join("\n"),
    ],
  ])("rejects a %s current-version entry", (_name, fixture) => {
    expect(() => assertChangelogContract("0.13.1", fixture)).toThrow();
  });
});
