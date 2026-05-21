import { describe, it, expect } from "vitest";
import {
  validateFrontmatter,
  type Frontmatter,
} from "../../src/storage/frontmatter.js";

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
