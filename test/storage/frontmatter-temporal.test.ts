import { describe, it, expect } from "vitest";
import { serializeFrontmatter, parseFrontmatter } from "../../src/storage/frontmatter.js";

describe("temporal fields", () => {
  it("round-trips valid_from, valid_until, and observed_at through serialize/parse", () => {
    const fm = {
      type: "tools" as const,
      title: "test tool",
      created: "2026-01-01",
      updated: "2026-06-01",
      valid_from: "2026-01-01",
      valid_until: "2026-06-01",
      observed_at: "2026-06-09",
    };
    const serialized = serializeFrontmatter(fm, "body");
    const parsed = parseFrontmatter(serialized);
    expect(parsed.frontmatter.valid_from).toBe("2026-01-01");
    expect(parsed.frontmatter.valid_until).toBe("2026-06-01");
    expect(parsed.frontmatter.observed_at).toBe("2026-06-09");
  });

  it("omits temporal fields when undefined", () => {
    const fm = {
      type: "tools" as const,
      title: "test tool",
      created: "2026-01-01",
      updated: "2026-06-01",
    };
    const serialized = serializeFrontmatter(fm, "body");
    expect(serialized).not.toContain("valid_from");
    expect(serialized).not.toContain("valid_until");
    expect(serialized).not.toContain("observed_at");
  });

  it("preserves valid_until alongside status: superseded", () => {
    const fm = {
      type: "tools" as const,
      title: "old tool",
      created: "2025-01-01",
      updated: "2026-06-09",
      status: "superseded" as const,
      valid_until: "2026-06-09",
    };
    const serialized = serializeFrontmatter(fm, "body");
    const parsed = parseFrontmatter(serialized);
    expect(parsed.frontmatter.status).toBe("superseded");
    expect(parsed.frontmatter.valid_until).toBe("2026-06-09");
  });
});
