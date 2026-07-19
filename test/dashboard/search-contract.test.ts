import { describe, expect, it } from "vitest";
import {
  collectIndexIgnoredSearchParams,
  resolveIndexSearchBackend,
} from "../../src/dashboard/server.js";

describe("search contract (index ignored params)", () => {
  it("lists only non-default advanced params as ignored", () => {
    const url = new URL(
      "http://127.0.0.1:4410/memory/api/search?q=hello&scope=wiki&minScore=0.3&as_of=2026-01-01&noRerank=true&identity_mode=inclusive",
    );
    expect(collectIndexIgnoredSearchParams(url)).toEqual(["scope", "minScore", "as_of"]);
  });

  it("flags noRerank only when the client requested rerank", () => {
    const wantRerank = new URL("http://127.0.0.1/api/search?q=x&noRerank=false");
    expect(collectIndexIgnoredSearchParams(wantRerank)).toEqual(["noRerank"]);

    const defaultNoRerank = new URL("http://127.0.0.1/api/search?q=x&noRerank=true");
    expect(collectIndexIgnoredSearchParams(defaultNoRerank)).toEqual([]);
  });

  it("flags identity and HyDE filters when supplied", () => {
    const url = new URL(
      "http://127.0.0.1/api/search?q=x&agent_id=a1&user_id=u1&identity_mode=strict&hydeExpansion=expanded+text&intent=current-truth",
    );
    expect(collectIndexIgnoredSearchParams(url)).toEqual([
      "hydeExpansion",
      "intent",
      "agent_id",
      "user_id",
      "identity_mode",
    ]);
  });

  it("returns empty when only q/k/limit/cursor are used", () => {
    const url = new URL("http://127.0.0.1/api/search?q=needle&k=10&limit=10&cursor=0&scope=all");
    expect(collectIndexIgnoredSearchParams(url)).toEqual([]);
  });

  it("resolves index backend label from MEMORY_INDEX_VECTORS", () => {
    expect(resolveIndexSearchBackend({})).toBe("index-lexical");
    expect(resolveIndexSearchBackend({ MEMORY_INDEX_VECTORS: "1" })).toBe("index-hybrid");
    expect(resolveIndexSearchBackend({ MEMORY_INDEX_VECTORS: "0" })).toBe("index-lexical");
  });
});
