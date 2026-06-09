import { describe, it, expect } from "vitest";
import type { SearchDocument } from "../../src/retrieval/corpus.js";
import {
  buildContextualizedText,
  computeBacklinkMap,
  hashContextBlock,
  buildContextBlock,
} from "../../src/retrieval/contextualized-text.js";
import { toEmbeddingText, hashEmbeddingBody } from "../../src/retrieval/embedding-text.js";

function stubDoc(overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    kind: "wiki",
    relPath: "wiki/projects/test.md",
    fullPath: "C:/vault/wiki/projects/test.md",
    title: "Test",
    type: "projects",
    status: "active",
    cognitiveType: "semantic",
    confidence: 0.8,
    tags: [],
    relations: {},
    source: "unknown",
    session: null,
    importedFrom: null,
    body: "This is the page body.",
    snippetSource: "",
    mtime: "2026-05-20T00:00:00.000Z",
    sizeBytes: 0,
    created: "2026-05-01",
    observedAt: null,
    updated: "2026-05-20",
    ...overrides,
  };
}

describe("contextualized embedding text", () => {
  it("embeds context block + body when contextualized", () => {
    const doc = stubDoc();
    const text = buildContextualizedText(doc, ["backlink-page"]);
    expect(text).toContain(doc.relPath);
    expect(text).toContain(doc.body);
  });

  it("content hash differs from context hash", () => {
    const doc = stubDoc();
    const contentHash = hashEmbeddingBody(doc.body);
    const contextBlock = buildContextBlock(doc, []);
    const contextHash = hashContextBlock(contextBlock);
    expect(contentHash).not.toBe(contextHash);
  });

  it("context hash changes when relations change but body stays same", () => {
    const doc1 = stubDoc({ relations: { uses: [{ target: "alpha" }] } });
    const doc2 = stubDoc({ relations: { uses: [{ target: "beta" }] } });
    const h1 = hashContextBlock(buildContextBlock(doc1, []));
    const h2 = hashContextBlock(buildContextBlock(doc2, []));
    expect(h1).not.toBe(h2);
  });

  it("neither hash changes when both are unchanged", () => {
    const doc = stubDoc();
    const bl = ["x"];
    const h1 = hashContextBlock(buildContextBlock(doc, bl));
    const h2 = hashContextBlock(buildContextBlock(doc, bl));
    const c1 = hashEmbeddingBody(doc.body);
    const c2 = hashEmbeddingBody(doc.body);
    expect(h1).toBe(h2);
    expect(c1).toBe(c2);
  });
});
