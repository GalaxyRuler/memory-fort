import { describe, expect, it } from "vitest";
import { buildGraph, expandGraph } from "../../src/retrieval/graph.js";
import type { SearchDocument } from "../../src/retrieval/corpus.js";

function doc(
  relPath: string,
  overrides: Partial<SearchDocument> = {},
): SearchDocument {
  return {
    kind: "wiki",
    relPath,
    fullPath: `C:/vault/${relPath}`,
    title: relPath,
    type: "projects",
    status: "active",
    confidence: 0.8,
    tags: [],
    relations: {},
    source: "unknown",
    session: null,
    body: "",
    snippetSource: "",
    mtime: "2026-05-23T00:00:00.000Z",
    sizeBytes: 0,
    ...overrides,
  };
}

describe("retrieval graph signal", () => {
  it("buildGraph extracts relation edges", () => {
    const a = doc("wiki/projects/a.md", {
      relations: { uses: ["b"], depends_on: ["b"] },
    });
    const b = doc("wiki/projects/b.md");

    const graph = buildGraph([a, b]);

    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        {
          fromPath: "wiki/projects/a.md",
          toPath: "wiki/projects/b.md",
          kind: "relation",
          relationType: "uses",
        },
        {
          fromPath: "wiki/projects/a.md",
          toPath: "wiki/projects/b.md",
          kind: "relation",
          relationType: "depends_on",
        },
      ]),
    );
    expect(graph.unresolvedTargets).toEqual([]);
  });

  it("buildGraph extracts wikilink edges from body", () => {
    const a = doc("wiki/projects/a.md", {
      body: "Some text linking to [[b]] and [[ghost]] here.",
    });
    const b = doc("wiki/projects/b.md");

    const graph = buildGraph([a, b]);

    expect(graph.edges).toEqual([
      {
        fromPath: "wiki/projects/a.md",
        toPath: "wiki/projects/b.md",
        kind: "wikilink",
        relationType: null,
      },
    ]);
    expect(graph.unresolvedTargets).toEqual([
      { fromPath: "wiki/projects/a.md", raw: "ghost", reason: "not-found" },
    ]);
  });

  it("buildGraph resolves ambiguous filenames as unresolved", () => {
    const a = doc("wiki/projects/foo.md");
    const b = doc("wiki/lessons/foo.md");
    const c = doc("wiki/projects/c.md", { body: "[[foo]]" });

    const graph = buildGraph([a, b, c]);

    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedTargets).toEqual([
      {
        fromPath: "wiki/projects/c.md",
        raw: "foo",
        reason: "ambiguous-filename",
      },
    ]);
  });

  it("expandGraph adds 1-hop neighbors of seed", () => {
    const graph = buildGraph([
      doc("wiki/projects/a.md", { relations: { uses: ["b"] } }),
      doc("wiki/projects/b.md", { relations: { uses: ["c"] } }),
      doc("wiki/projects/c.md", { relations: { uses: ["d"] } }),
      doc("wiki/projects/d.md"),
    ]);

    const result = expandGraph(new Set(["wiki/projects/a.md"]), graph, { hops: 1 });

    expect(result.expanded).toEqual(new Set(["wiki/projects/b.md"]));
    expect(result.pathToEdges.get("wiki/projects/b.md")).toEqual([
      {
        fromPath: "wiki/projects/a.md",
        toPath: "wiki/projects/b.md",
        kind: "relation",
        relationType: "uses",
      },
    ]);
  });

  it("expandGraph with hops=2 traverses two edges", () => {
    const graph = buildGraph([
      doc("wiki/projects/a.md", { relations: { uses: ["b"] } }),
      doc("wiki/projects/b.md", { relations: { uses: ["c"] } }),
      doc("wiki/projects/c.md", { relations: { uses: ["d"] } }),
      doc("wiki/projects/d.md"),
    ]);

    const result = expandGraph(new Set(["wiki/projects/a.md"]), graph, { hops: 2 });

    expect(result.expanded).toEqual(
      new Set(["wiki/projects/b.md", "wiki/projects/c.md"]),
    );
    expect(result.pathToEdges.get("wiki/projects/c.md")).toEqual([
      {
        fromPath: "wiki/projects/b.md",
        toPath: "wiki/projects/c.md",
        kind: "relation",
        relationType: "uses",
      },
    ]);
  });
});
