import { describe, expect, it, vi } from "vitest";
import { readRelations } from "../../src/retrieval/relations.js";

describe("readRelations", () => {
  it("parses bare-string entries as target shorthand", () => {
    expect(readRelations({ uses: ["wiki/tools/voyage.md"] })).toEqual({
      uses: [{ target: "wiki/tools/voyage.md" }],
    });
  });

  it("parses object entries with typed temporal fields and source metadata", () => {
    expect(readRelations({
      supersedes: [{
        target: "wiki/decisions/old.md",
        confidence: 0.85,
        valid_from: "2026-05-22",
        valid_to: null,
        superseded_by: "wiki/decisions/new.md",
        source: {
          agent: "codex",
          session_id: "session-123",
          captured_at: "2026-05-22T12:00:00.000Z",
        },
        review_state: "operator-confirmed",
      }],
    })).toEqual({
      supersedes: [{
        target: "wiki/decisions/old.md",
        confidence: 0.85,
        valid_from: "2026-05-22",
        valid_to: null,
        superseded_by: "wiki/decisions/new.md",
        source: {
          agent: "codex",
          session_id: "session-123",
          captured_at: "2026-05-22T12:00:00.000Z",
        },
        _extra: { review_state: "operator-confirmed" },
      }],
    });
  });

  it("parses mixed string and object arrays without whitelisting relation keys", () => {
    expect(readRelations({
      custom_edge: [
        "wiki/projects/a.md",
        { target: "wiki/projects/b.md", valid_to: "2026-05-23" },
      ],
    })).toEqual({
      custom_edge: [
        { target: "wiki/projects/a.md" },
        { target: "wiki/projects/b.md", valid_to: "2026-05-23" },
      ],
    });
  });

  it("drops malformed entries with a warning that includes path and index", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readRelations({ uses: [{ confidence: 0.5 }, 42, "wiki/tools/ok.md"] }, "wiki/projects/a.md")).toEqual({
      uses: [{ target: "wiki/tools/ok.md" }],
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("wiki/projects/a.md");
    expect(warn.mock.calls[0]?.[0]).toContain("relations.uses[0]");
    expect(warn.mock.calls[1]?.[0]).toContain("relations.uses[1]");

    warn.mockRestore();
  });

  it("returns empty relations for missing, empty, or non-object values", () => {
    expect(readRelations(undefined)).toEqual({});
    expect(readRelations({})).toEqual({});
    expect(readRelations([])).toEqual({});
    expect(readRelations("uses")).toEqual({});
  });
});
