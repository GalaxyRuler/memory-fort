import { describe, expect, it } from "vitest";
import {
  isIndexSearchEnabled,
  isIndexVectorsEnabled,
} from "../../src/index/env.js";

describe("index env policy", () => {
  it("enables index search by default with an explicit legacy opt-out", () => {
    expect(isIndexSearchEnabled({})).toBe(true);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: "" })).toBe(true);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: "1" })).toBe(true);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: "true" })).toBe(true);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: "legacy" })).toBe(true);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: "0" })).toBe(false);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: "false" })).toBe(false);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: "off" })).toBe(false);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: " NO " })).toBe(false);
    expect(isIndexSearchEnabled({ MEMORY_INDEX_SEARCH: "disabled" })).toBe(false);
  });

  it("keeps vector search and backfill opt-in only", () => {
    expect(isIndexVectorsEnabled({})).toBe(false);
    expect(isIndexVectorsEnabled({ MEMORY_INDEX_SEARCH: "1" })).toBe(false);
    expect(isIndexVectorsEnabled({ MEMORY_INDEX_VECTORS: "" })).toBe(false);
    expect(isIndexVectorsEnabled({ MEMORY_INDEX_VECTORS: "1" })).toBe(true);
    expect(isIndexVectorsEnabled({ MEMORY_INDEX_VECTORS: "true" })).toBe(true);
    expect(isIndexVectorsEnabled({ MEMORY_INDEX_VECTORS: "on" })).toBe(true);
    expect(isIndexVectorsEnabled({ MEMORY_INDEX_VECTORS: " enabled " })).toBe(true);
    expect(isIndexVectorsEnabled({ MEMORY_INDEX_VECTORS: "0" })).toBe(false);
    expect(isIndexVectorsEnabled({ MEMORY_INDEX_VECTORS: "auto" })).toBe(false);
  });
});
