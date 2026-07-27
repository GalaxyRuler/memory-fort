import { describe, expect, it } from "vitest";
import {
  preprocessWikilinks,
  wikiPathToRouterParams,
} from "../../../src/dashboard-ui/lib/wikilinks.js";
import type { PageRelation } from "../../../src/dashboard-ui/hooks/usePageDetail.js";

const fooRelation: PageRelation = {
  key: "uses",
  target: "foo",
  resolvedPath: "wiki/projects/foo.md",
  resolvedTitle: "Foo",
};

describe("preprocessWikilinks", () => {
  it("rewrites resolved and unresolved prose wikilinks case-insensitively", () => {
    expect(
      preprocessWikilinks(
        "See [[FoO]], [[missing]], and [[foo]] again.",
        [fooRelation],
      ),
    ).toBe(
      "See [FoO](wiki:wiki/projects/foo.md), [missing], and [foo](wiki:wiki/projects/foo.md) again.",
    );
  });

  it("preserves wikilinks inside single and multi-backtick inline code spans", () => {
    const body = "Before [[foo]], then `[[foo]]` and ``one ` plus [[foo]]``, after [[foo]].";

    expect(preprocessWikilinks(body, [fooRelation])).toBe(
      "Before [foo](wiki:wiki/projects/foo.md), then `[[foo]]` and ``one ` plus [[foo]]``, after [foo](wiki:wiki/projects/foo.md).",
    );
  });

  it("preserves wikilinks inside backtick fences with an info string", () => {
    const body = [
      "Before [[foo]].",
      "```ts title=example",
      "const linked = \"[[foo]]\";",
      "```",
      "After [[foo]].",
    ].join("\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "Before [foo](wiki:wiki/projects/foo.md).",
      "```ts title=example",
      "const linked = \"[[foo]]\";",
      "```",
      "After [foo](wiki:wiki/projects/foo.md).",
    ].join("\n"));
  });

  it("preserves wikilinks inside tilde fences", () => {
    const body = [
      "Before [[foo]].",
      "~~~markdown",
      "[[foo]]",
      "~~~~",
      "Between [[missing]].",
      "~~~",
      "[[foo]]",
    ].join("\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "Before [foo](wiki:wiki/projects/foo.md).",
      "~~~markdown",
      "[[foo]]",
      "~~~~",
      "Between [missing].",
      "~~~",
      "[[foo]]",
    ].join("\n"));
  });

  it("prefers explicit targets over filename aliases regardless of relation order", () => {
    const explicitTarget: PageRelation = {
      key: "uses",
      target: "shared",
      resolvedPath: "wiki/projects/explicit.md",
      resolvedTitle: "Explicit",
    };
    const conflictingAlias: PageRelation = {
      key: "related",
      target: "other",
      resolvedPath: "wiki/archive/shared.md",
      resolvedTitle: "Other",
    };

    const forward = preprocessWikilinks("[[SHARED]]", [explicitTarget, conflictingAlias]);
    const reversed = preprocessWikilinks("[[SHARED]]", [conflictingAlias, explicitTarget]);

    expect(forward).toBe("[SHARED](wiki:wiki/projects/explicit.md)");
    expect(reversed).toBe(forward);
  });

  it("resolves filename alias collisions to the same stable path regardless of relation order", () => {
    const firstAlias: PageRelation = {
      key: "uses",
      target: "first",
      resolvedPath: "wiki/z/shared.md",
      resolvedTitle: "First",
    };
    const secondAlias: PageRelation = {
      key: "related",
      target: "second",
      resolvedPath: "wiki/a/shared.md",
      resolvedTitle: "Second",
    };

    const forward = preprocessWikilinks("[[shared]]", [firstAlias, secondAlias]);
    const reversed = preprocessWikilinks("[[shared]]", [secondAlias, firstAlias]);

    expect(forward).toBe("[shared](wiki:wiki/a/shared.md)");
    expect(reversed).toBe(forward);
  });
});

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
