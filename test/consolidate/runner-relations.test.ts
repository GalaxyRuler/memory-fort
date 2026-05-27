import { describe, expect, it } from "vitest";
import { readRelations, writeRelations } from "../../src/retrieval/relations.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../../src/storage/frontmatter.js";

describe("relation writer", () => {
  it("serializes target-only edges as byte-identical string shorthand", () => {
    const body = "Observation body.\n";
    const base: Frontmatter = {
      type: "raw-session",
      title: "Raw",
      created: "2026-05-27",
      updated: "2026-05-27",
      relations: { mentions: ["wiki/a.md", "wiki/b.md"] },
    };
    const next: Frontmatter = {
      ...base,
      relations: writeRelations({
        mentions: [{ target: "wiki/a.md" }, { target: "wiki/b.md" }],
      }),
    };

    expect(serializeFrontmatter(next, body)).toBe(serializeFrontmatter(base, body));
  });

  it("serializes rich edges as YAML objects", () => {
    const serialized = serializeFrontmatter({
      type: "raw-session",
      title: "Raw",
      created: "2026-05-27",
      updated: "2026-05-27",
      relations: writeRelations({
        mentions: [{ target: "wiki/a.md", valid_from: "2026-05-22", confidence: 0.85 }],
      }),
    }, "Body.\n");

    expect(serialized).toContain("mentions:\n    - target: wiki/a.md\n      confidence: 0.85\n      valid_from: 2026-05-22");
  });

  it("roundtrips write to parse to read", () => {
    const written = serializeFrontmatter({
      type: "raw-session",
      title: "Raw",
      created: "2026-05-27",
      updated: "2026-05-27",
      relations: writeRelations({
        mentions: [
          { target: "wiki/a.md" },
          { target: "wiki/b.md", valid_to: "2026-05-23", superseded_by: "wiki/c.md" },
        ],
      }),
    }, "Body.\n");
    const parsed = parseFrontmatter(written);

    expect(readRelations(parsed.frontmatter.relations)).toEqual({
      mentions: [
        { target: "wiki/a.md" },
        { target: "wiki/b.md", valid_to: "2026-05-23", superseded_by: "wiki/c.md" },
      ],
    });
  });

  it("orders schema relation keys first and user-defined keys alphabetically", () => {
    expect(Object.keys(writeRelations({
      zeta: [{ target: "wiki/z.md" }],
      linked: [{ target: "wiki/linked.md" }],
      mentions: [{ target: "wiki/mentions.md" }],
      alpha: [{ target: "wiki/a.md" }],
      uses: [{ target: "wiki/uses.md" }],
    }))).toEqual(["mentions", "uses", "linked", "alpha", "zeta"]);
  });

  it("sorts confidence-bearing edges descending before target-only edges", () => {
    expect(writeRelations({
      mentions: [
        { target: "wiki/a.md", confidence: 0.5 },
        { target: "wiki/b.md" },
        { target: "wiki/c.md", confidence: 0.9 },
      ],
    }).mentions).toEqual([
      { target: "wiki/c.md", confidence: 0.9 },
      { target: "wiki/a.md", confidence: 0.5 },
      "wiki/b.md",
    ]);
  });
});
