import { describe, expect, it } from "vitest";
import { wikiPathToRouterParams } from "../../../src/dashboard-ui/lib/wikilinks.js";

describe("wikiPathToRouterParams", () => {
  it("parses a canonical nested wiki page path with supported component characters", () => {
    expect(wikiPathToRouterParams("wiki/projects_2/nested-folder/foo.bar_baz-1.md")).toEqual({
      category: "projects_2",
      slug: "nested-folder/foo.bar_baz-1",
    });
  });

  it.each([
    "Wiki/projects/foo.md",
    "wiki/../settings.md",
    "wiki/projects/../settings.md",
    "wiki/projects/./settings.md",
    "wiki//foo.md",
    "wiki/projects/foo//bar.md",
    "wiki/projects/.md",
    "wiki/projects/foo",
    "wiki/projects\\foo.md",
    "wiki/projects/foo.md?download=1",
    "wiki/projects/foo.md#heading",
    "wiki/projects/foo%2Fbar.md",
    "wiki/projects/foo%5cbar.md",
    "wiki/projects/%2e%2e/settings.md",
    "wiki/projects/.%2E/settings.md",
    "wiki/projects/%252e%252e/settings.md",
    "wiki/projects/foo..bar.md",
    "wiki/projects/foo%ZZ.md",
    "wiki/projects/foo%41.md",
    "wiki/projects/%25%32%65%25%32%65/settings.md",
  ])("rejects the malformed or noncanonical path %s", (path) => {
    expect(wikiPathToRouterParams(path)).toBeNull();
  });
});
