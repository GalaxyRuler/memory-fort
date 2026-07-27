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

  it("preserves wikilinks inside a tilde fence nested in a blockquote", () => {
    const body = [
      "Before [[foo]].",
      "> ~~~md",
      "> [[foo]]",
      "> ~~~",
      "After [[foo]].",
    ].join("\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "Before [foo](wiki:wiki/projects/foo.md).",
      "> ~~~md",
      "> [[foo]]",
      "> ~~~",
      "After [foo](wiki:wiki/projects/foo.md).",
    ].join("\n"));
  });

  it("preserves wikilinks inside a backtick fence nested in a list item", () => {
    const body = [
      "Before [[foo]].",
      "- ```md",
      "  [[foo]]",
      "  ```",
      "After [[foo]].",
    ].join("\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "Before [foo](wiki:wiki/projects/foo.md).",
      "- ```md",
      "  [[foo]]",
      "  ```",
      "After [foo](wiki:wiki/projects/foo.md).",
    ].join("\n"));
  });

  it.each([
    {
      name: "blockquote",
      body: [
        "> ```md",
        "> [[foo]]",
        "Outside [[foo]].",
      ].join("\n"),
      expected: [
        "> ```md",
        "> [[foo]]",
        "Outside [foo](wiki:wiki/projects/foo.md).",
      ].join("\n"),
    },
    {
      name: "list item",
      body: [
        "- ```md",
        "  [[foo]]",
        "Outside [[foo]].",
      ].join("\n"),
      expected: [
        "- ```md",
        "  [[foo]]",
        "Outside [foo](wiki:wiki/projects/foo.md).",
      ].join("\n"),
    },
  ])("ends an unclosed fence when its $name container ends", ({ body, expected }) => {
    expect(preprocessWikilinks(body, [fooRelation])).toBe(expected);
  });

  it("preserves a fenced block nested through a list into a blockquote", () => {
    const body = [
      "- > ```md",
      "  > [[foo]]",
      "  > ```",
      "Outside [[foo]].",
    ].join("\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "- > ```md",
      "  > [[foo]]",
      "  > ```",
      "Outside [foo](wiki:wiki/projects/foo.md).",
    ].join("\n"));
  });

  it("preserves a fenced block nested through a blockquote, list, and blockquote", () => {
    const body = [
      "> - > ~~~md",
      ">   > [[foo]]",
      ">   > ~~~",
      "Outside [[foo]].",
    ].join("\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "> - > ~~~md",
      ">   > [[foo]]",
      ">   > ~~~",
      "Outside [foo](wiki:wiki/projects/foo.md).",
    ].join("\n"));
  });

  it("follows remark when an ordered list marker cannot interrupt a paragraph", () => {
    const body = [
      "Paragraph",
      "2. ```md",
      "   [[foo]]",
      "   ```",
      "After [[foo]]",
    ].join("\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "Paragraph",
      "2. ```md",
      "   [foo](wiki:wiki/projects/foo.md)",
      "   ```",
      "After [[foo]]",
    ].join("\n"));
  });

  it("preserves a list fence with tab-indented content and closing delimiter", () => {
    const body = [
      "- ```md",
      "\t[[foo]]",
      "\t```",
      "After [[foo]].",
    ].join("\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "- ```md",
      "\t[[foo]]",
      "\t```",
      "After [foo](wiki:wiki/projects/foo.md).",
    ].join("\n"));
  });

  it("uses remark source offsets correctly with CRLF line endings", () => {
    const body = [
      "Before [[foo]].",
      "```md",
      "[[foo]]",
      "```",
      "After [[foo]].",
    ].join("\r\n");

    expect(preprocessWikilinks(body, [fooRelation])).toBe([
      "Before [foo](wiki:wiki/projects/foo.md).",
      "```md",
      "[[foo]]",
      "```",
      "After [foo](wiki:wiki/projects/foo.md).",
    ].join("\r\n"));
  });

  it("treats odd-backslash escaped backtick runs as prose delimiters", () => {
    const body = "\\`[[foo]]\\` and [[foo]], but \\\\`[[foo]]\\\\` stays code.";

    expect(preprocessWikilinks(body, [fooRelation])).toBe(
      "\\`[foo](wiki:wiki/projects/foo.md)\\` and [foo](wiki:wiki/projects/foo.md), but \\\\`[[foo]]\\\\` stays code.",
    );
  });

  it("preserves inline code formed by the unescaped remainder of a backtick run", () => {
    const body = "\\``[[foo]]` and [[foo]].";

    expect(preprocessWikilinks(body, [fooRelation])).toBe(
      "\\``[[foo]]` and [foo](wiki:wiki/projects/foo.md).",
    );
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
