import { describe, it, expect, vi } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  type Frontmatter,
} from "../../src/storage/frontmatter.js";
import { RELATION_TYPES, writeRelations } from "../../src/retrieval/relations.js";

const baseValid: Frontmatter = {
  type: "projects",
  title: "test",
  created: "2026-05-21",
  updated: "2026-05-21",
};

describe("validateFrontmatter - confidence", () => {
  it("accepts confidence 0", () => {
    expect(validateFrontmatter({ ...baseValid, confidence: 0 }).valid).toBe(true);
  });

  it("accepts confidence 1", () => {
    expect(validateFrontmatter({ ...baseValid, confidence: 1 }).valid).toBe(true);
  });

  it("accepts confidence 0.7", () => {
    expect(validateFrontmatter({ ...baseValid, confidence: 0.7 }).valid).toBe(
      true,
    );
  });

  it("accepts vector confidence with validation state", () => {
    expect(
      validateFrontmatter({
        ...baseValid,
        confidence: { extraction: 0.7, validation: "user" },
      }).valid,
    ).toBe(true);
  });

  it("rejects confidence < 0", () => {
    const r = validateFrontmatter({ ...baseValid, confidence: -0.1 });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("confidence"))).toBe(true);
    }
  });

  it("rejects confidence > 1", () => {
    const r = validateFrontmatter({ ...baseValid, confidence: 1.5 });
    expect(r.valid).toBe(false);
  });

  it("rejects non-numeric confidence", () => {
    const r = validateFrontmatter({
      ...baseValid,
      confidence: "high" as unknown as number,
    });
    expect(r.valid).toBe(false);
  });

  it("rejects vector confidence with invalid validation state", () => {
    const r = validateFrontmatter({
      ...baseValid,
      confidence: { extraction: 0.7, validation: "bogus" },
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("confidence.validation"))).toBe(
        true,
      );
    }
  });

  it("rejects vector confidence with out-of-range source score", () => {
    const r = validateFrontmatter({
      ...baseValid,
      confidence: { source: 1.2 },
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("confidence.source"))).toBe(true);
    }
  });
});

describe("validateFrontmatter - lifecycle", () => {
  it("accepts known lifecycle stages", () => {
    expect(validateFrontmatter({ ...baseValid, lifecycle: "canonical" }).valid).toBe(
      true,
    );
  });

  it("rejects unknown lifecycle stages", () => {
    const r = validateFrontmatter({ ...baseValid, lifecycle: "bogus" });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("lifecycle"))).toBe(true);
    }
  });
});

describe("validateFrontmatter - tags", () => {
  it("accepts empty tags array", () => {
    expect(validateFrontmatter({ ...baseValid, tags: [] }).valid).toBe(true);
  });

  it("accepts tags with string values", () => {
    expect(
      validateFrontmatter({ ...baseValid, tags: ["windows", "stability"] })
        .valid,
    ).toBe(true);
  });

  it("rejects non-array tags", () => {
    const r = validateFrontmatter({
      ...baseValid,
      tags: "single-tag" as unknown as string[],
    });
    expect(r.valid).toBe(false);
  });

  it("rejects tags array containing non-strings", () => {
    const r = validateFrontmatter({
      ...baseValid,
      tags: ["ok", 42 as unknown as string],
    });
    expect(r.valid).toBe(false);
  });
});

describe("validateFrontmatter - relations", () => {
  it("accepts exactly the canonical relation types used by relation serialization", () => {
    const relations = Object.fromEntries(
      RELATION_TYPES.map((relation) => [relation, [`wiki/${relation}.md`]]),
    );

    const result = validateFrontmatter({ ...baseValid, relations });

    expect(result.valid).toBe(true);
    expect(Object.keys(writeRelations(readableRelationMap(relations)))).toEqual([
      ...RELATION_TYPES,
    ]);
    expect(validateFrontmatter({
      ...baseValid,
      relations: { supports: ["wiki/support.md"] },
    }).valid).toBe(false);
  });

  it("accepts known edge types with string-array values", () => {
    const r = validateFrontmatter({
      ...baseValid,
      relations: {
        uses: ["typescript"],
        depends_on: ["iii-engine"],
        contradicts: ["lessons/old-belief"],
      },
    });
    expect(r.valid).toBe(true);
  });

  it("rejects unknown edge type keys", () => {
    const r = validateFrontmatter({
      ...baseValid,
      relations: { invents: ["x"] } as never,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("invents"))).toBe(true);
    }
  });

  it("rejects non-array values for known edge types", () => {
    const r = validateFrontmatter({
      ...baseValid,
      relations: { uses: "not-an-array" } as never,
    });
    expect(r.valid).toBe(false);
  });

  it("rejects array values containing non-strings", () => {
    const r = validateFrontmatter({
      ...baseValid,
      relations: { uses: [42] } as never,
    });
    expect(r.valid).toBe(false);
  });

  it("rejects non-object relations", () => {
    const r = validateFrontmatter({
      ...baseValid,
      relations: ["uses", "depends_on"] as never,
    });
    expect(r.valid).toBe(false);
  });

  it("accepts frontmatter without a relations field (optional)", () => {
    expect(validateFrontmatter(baseValid).valid).toBe(true);
  });
});

function readableRelationMap(relations: Record<string, string[]>): Record<string, { target: string }[]> {
  return Object.fromEntries(
    Object.entries(relations).map(([key, targets]) => [
      key,
      targets.map((target) => ({ target })),
    ]),
  );
}

describe("frontmatter - time_range", () => {
  it("round-trips valid time_range metadata", () => {
    const original: Frontmatter = {
      ...baseValid,
      type: "threads",
      time_range: {
        start: "2026-05-22",
        end: null,
      },
    };

    const { frontmatter } = parseFrontmatter(
      serializeFrontmatter(original, "Thread body.\n"),
    );

    expect(frontmatter.time_range).toEqual({
      start: "2026-05-22",
      end: null,
    });
    expect(validateFrontmatter(frontmatter).valid).toBe(true);
  });

  it("drops malformed time_range values with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { frontmatter } = parseFrontmatter(
      [
        "---",
        "type: threads",
        "title: Bad Thread",
        "created: 2026-05-22",
        "updated: 2026-05-22",
        "time_range:",
        "  end: 2026-05-27",
        "---",
        "body",
      ].join("\n"),
    );

    expect(frontmatter.time_range).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Dropped malformed time_range"));
    warn.mockRestore();
  });
});

describe("validateFrontmatter - combinations", () => {
  it("collects multiple errors at once", () => {
    const r = validateFrontmatter({
      ...baseValid,
      confidence: 99,
      tags: 42 as never,
      relations: { bogus: ["x"] } as never,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("accepts a fully-loaded valid frontmatter (Phase 2 superset)", () => {
    const r = validateFrontmatter({
      ...baseValid,
      status: "active",
      confidence: 0.85,
      tags: ["windows", "stability"],
      relations: {
        uses: ["typescript", "vitest"],
        depends_on: ["iii-engine"],
        fixed_by: ["lessons/dead-pid-survivors"],
      },
    });
    expect(r.valid).toBe(true);
  });
});
