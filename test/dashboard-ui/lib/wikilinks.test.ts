import { describe, expect, it } from "vitest";
import { wikiPathToRouterParams } from "../../../src/dashboard-ui/lib/wikilinks.js";

describe("wikiPathToRouterParams", () => {
  it("parses a canonical nested wiki page path", () => {
    expect(wikiPathToRouterParams("wiki/projects/nested/foo.md")).toEqual({
      category: "projects",
      slug: "nested/foo",
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
  ])("rejects the malformed or noncanonical path %s", (path) => {
    expect(wikiPathToRouterParams(path)).toBeNull();
  });
});
