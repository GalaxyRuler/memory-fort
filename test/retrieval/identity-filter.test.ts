import { describe, it, expect } from "vitest";
import { filterDocumentsByIdentity } from "../../src/retrieval/identity-filter.js";
import type { SearchDocument } from "../../src/retrieval/corpus.js";

function makeDoc(rawFm: Record<string, unknown> = {}, kind: string = "wiki"): SearchDocument {
  return {
    relPath: "wiki/tools/test.md",
    fullPath: "/fake/wiki/tools/test.md",
    kind,
    body: "test",
    title: "Test",
    type: "tools",
    status: "active",
    cognitiveType: "semantic",
    confidence: null,
    tags: [],
    relations: new Map(),
    source: "wiki",
    session: null,
    importedFrom: null,
    snippetSource: "test",
    created: "2026-01-01",
    observedAt: null,
    updated: "2026-01-01",
    mtime: "2026-01-01",
    sizeBytes: 100,
    rawFrontmatter: Object.keys(rawFm).length ? rawFm : null,
  } as unknown as SearchDocument;
}

describe("filterDocumentsByIdentity — inclusive mode (default)", () => {
  it("passes all docs when no filter set", () => {
    const docs = [makeDoc({ agent_id: "a" }), makeDoc({ agent_id: "b" })];
    expect(filterDocumentsByIdentity(docs, {})).toHaveLength(2);
  });

  it("filters by agent_id", () => {
    const docs = [makeDoc({ agent_id: "codex-prod" }, "raw"), makeDoc({ agent_id: "claude" }, "raw")];
    const filtered = filterDocumentsByIdentity(docs, { agentId: "codex-prod" });
    expect(filtered).toHaveLength(1);
  });

  it("passes untagged docs (wiki pages) even when filter is set", () => {
    const docs = [makeDoc({ agent_id: "codex-prod" }, "raw"), makeDoc()];
    const filtered = filterDocumentsByIdentity(docs, { agentId: "codex-prod" });
    expect(filtered).toHaveLength(2);
  });

  it("filters by user_id", () => {
    const docs = [makeDoc({ user_id: "alice" }, "raw"), makeDoc({ user_id: "bob" }, "raw"), makeDoc()];
    const filtered = filterDocumentsByIdentity(docs, { userId: "alice" });
    expect(filtered).toHaveLength(2); // alice + untagged
  });

  it("a doc with user_id but no agent_id is excluded when agentId filter is set", () => {
    const docs = [makeDoc({ user_id: "bob" }, "raw")];
    const filtered = filterDocumentsByIdentity(docs, { agentId: "codex-prod" });
    // Doc has identity tags but no matching agent_id — excluded in inclusive mode
    // because it IS tagged (just not with the requested identity)
    expect(filtered).toHaveLength(0);
  });

  it("combined agentId + userId filter requires both to match on tagged docs", () => {
    const docs = [
      makeDoc({ agent_id: "codex-prod", user_id: "alice" }, "raw"),
      makeDoc({ agent_id: "codex-prod", user_id: "bob" }, "raw"),
      makeDoc(),
    ];
    const filtered = filterDocumentsByIdentity(docs, { agentId: "codex-prod", userId: "alice" });
    expect(filtered).toHaveLength(2); // matching pair + untagged
  });
});

describe("filterDocumentsByIdentity — strict mode", () => {
  it("excludes untagged docs in strict mode", () => {
    const docs = [makeDoc({ agent_id: "codex-prod" }, "raw"), makeDoc()];
    const filtered = filterDocumentsByIdentity(docs, { agentId: "codex-prod", mode: "strict" });
    expect(filtered).toHaveLength(1);
  });

  it("excludes tagged docs that do not match in strict mode", () => {
    const docs = [makeDoc({ agent_id: "claude" }, "raw")];
    const filtered = filterDocumentsByIdentity(docs, { agentId: "codex-prod", mode: "strict" });
    expect(filtered).toHaveLength(0);
  });
});
