import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  type Frontmatter,
} from "../src/storage/frontmatter.js";

describe("frontmatter", () => {
  const valid: Frontmatter = {
    type: "projects",
    title: "agentmemory",
    created: "2026-05-20",
    updated: "2026-05-21",
    status: "active",
    tags: ["windows", "stability"],
  };

  it("parses frontmatter and body", () => {
    const md = `---\ntype: projects\ntitle: agentmemory\ncreated: "2026-05-20"\nupdated: "2026-05-21"\n---\n\nHello body.\n`;
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.type).toBe("projects");
    expect(frontmatter.title).toBe("agentmemory");
    expect(body.trim()).toBe("Hello body.");
  });

  it("round-trips: parse -> serialize -> parse equivalent", () => {
    const md = serializeFrontmatter(valid, "body content\n");
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.type).toBe(valid.type);
    expect(frontmatter.title).toBe(valid.title);
    expect(frontmatter.created).toBe(valid.created);
    expect(frontmatter.tags).toEqual(valid.tags);
    expect(body.trim()).toBe("body content");
  });

  it("validates a correct frontmatter", () => {
    const r = validateFrontmatter(valid);
    expect(r.valid).toBe(true);
  });

  it("rejects missing required fields", () => {
    const r = validateFrontmatter({ type: "projects" });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("title"))).toBe(true);
      expect(r.errors.some((e) => e.includes("created"))).toBe(true);
    }
  });

  it("rejects unknown type", () => {
    const r = validateFrontmatter({
      ...valid,
      type: "frobnicate" as unknown,
    });
    expect(r.valid).toBe(false);
  });

  it("rejects malformed date", () => {
    const r = validateFrontmatter({
      ...valid,
      created: "2026-5-20",
    });
    expect(r.valid).toBe(false);
  });

  it("rejects unknown status", () => {
    const r = validateFrontmatter({
      ...valid,
      status: "garbage" as unknown,
    });
    expect(r.valid).toBe(false);
  });
});
