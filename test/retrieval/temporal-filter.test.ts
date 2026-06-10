import { describe, it, expect } from "vitest";
import { filterDocumentsByValidity, parseAsOf } from "../../src/retrieval/temporal-filter.js";
import type { SearchDocument } from "../../src/retrieval/corpus.js";

function makeDoc(fm: Record<string, unknown> = {}): SearchDocument {
  return {
    relPath: "wiki/tools/test.md",
    fullPath: "/fake/wiki/tools/test.md",
    kind: "wiki",
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
    rawFrontmatter: Object.keys(fm).length ? fm : null,
  } as unknown as SearchDocument;
}

describe("filterDocumentsByValidity", () => {
  it("passes all docs when asOf is undefined", () => {
    const docs = [makeDoc({ valid_from: "2025-01-01", valid_until: "2026-01-01" })];
    expect(filterDocumentsByValidity(docs, undefined)).toHaveLength(1);
  });

  it("passes docs that are valid at the asOf date", () => {
    const docs = [makeDoc({ valid_from: "2025-01-01", valid_until: "2026-12-31" })];
    expect(filterDocumentsByValidity(docs, "2026-06-01")).toHaveLength(1);
  });

  it("excludes docs whose valid_until is before asOf", () => {
    const docs = [makeDoc({ valid_from: "2025-01-01", valid_until: "2026-01-01" })];
    expect(filterDocumentsByValidity(docs, "2026-06-01")).toHaveLength(0);
  });

  it("excludes docs whose valid_from is after asOf", () => {
    const docs = [makeDoc({ valid_from: "2027-01-01" })];
    expect(filterDocumentsByValidity(docs, "2026-06-01")).toHaveLength(0);
  });

  it("passes untemporalized docs (no valid_from or valid_until)", () => {
    const docs = [makeDoc()];
    expect(filterDocumentsByValidity(docs, "2026-06-01")).toHaveLength(1);
  });

  it("passes docs with only valid_from set and asOf is after", () => {
    const docs = [makeDoc({ valid_from: "2025-01-01" })];
    expect(filterDocumentsByValidity(docs, "2026-06-01")).toHaveLength(1);
  });

  it("includes doc when asOf equals valid_until (inclusive date semantics)", () => {
    const docs = [makeDoc({ valid_from: "2025-01-01", valid_until: "2026-06-09" })];
    expect(filterDocumentsByValidity(docs, "2026-06-09")).toHaveLength(1);
  });

  it("excludes doc when asOf is one day after valid_until", () => {
    const docs = [makeDoc({ valid_from: "2025-01-01", valid_until: "2026-06-09" })];
    expect(filterDocumentsByValidity(docs, "2026-06-10")).toHaveLength(0);
  });

  it("includes doc when asOf equals valid_from", () => {
    const docs = [makeDoc({ valid_from: "2026-06-01", valid_until: "2026-12-31" })];
    expect(filterDocumentsByValidity(docs, "2026-06-01")).toHaveLength(1);
  });
});

describe("parseAsOf", () => {
  it("returns undefined for undefined input", () => {
    expect(parseAsOf(undefined)).toBeUndefined();
  });

  it("returns Date for valid ISO string", () => {
    const result = parseAsOf("2026-06-09");
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString().slice(0, 10)).toBe("2026-06-09");
  });

  it("throws for invalid date string", () => {
    expect(() => parseAsOf("not-a-date")).toThrow("invalid asOf date");
  });

  it("throws for empty string", () => {
    expect(() => parseAsOf("")).toThrow("invalid asOf date");
  });
});
