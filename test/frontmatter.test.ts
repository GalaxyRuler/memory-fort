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

  it("round-trips prospective scheduling fields", () => {
    const md = serializeFrontmatter(
      {
        ...valid,
        type: "prospective",
        cognitive_type: "prospective",
        due: "2026-06-01",
        triggers: ["next verify run", "weekly review"],
        expires: null,
      },
      "body content\n",
    );

    const { frontmatter } = parseFrontmatter(md);

    expect(frontmatter.type).toBe("prospective");
    expect(frontmatter.cognitive_type).toBe("prospective");
    expect(frontmatter.due).toBe("2026-06-01");
    expect(frontmatter.triggers).toEqual(["next verify run", "weekly review"]);
    expect(frontmatter.expires).toBeNull();
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

  it("accepts prospective type and cognitive_type", () => {
    const r = validateFrontmatter({
      ...valid,
      type: "prospective",
      cognitive_type: "prospective",
      due: "2026-06-01",
      triggers: ["next verify run"],
      expires: null,
    });

    expect(r.valid).toBe(true);
  });

  it("rejects malformed prospective fields", () => {
    const r = validateFrontmatter({
      ...valid,
      type: "prospective",
      due: ["2026-06-01"],
      triggers: ["ok", 42],
      expires: { after: "launch" },
    });

    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("due"))).toBe(true);
      expect(r.errors.some((e) => e.includes("triggers"))).toBe(true);
      expect(r.errors.some((e) => e.includes("expires"))).toBe(true);
    }
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

describe("frontmatter YAML date coercion", () => {
  it("unquoted YYYY-MM-DD parses as a string, not a Date", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ncreated: 2026-05-22\nupdated: 2026-05-22\ntype: projects\ntitle: T\n---\nbody\n",
    );
    expect(typeof frontmatter.created).toBe("string");
    expect(frontmatter.created).toBe("2026-05-22");
    expect(typeof frontmatter.updated).toBe("string");
    expect(frontmatter.updated).toBe("2026-05-22");
  });

  it("round-trip preserves the unquoted date as a string", () => {
    const original =
      "---\ncreated: 2026-05-22\nupdated: 2026-05-22\ntype: projects\ntitle: T\n---\nbody\n";
    const { frontmatter, body } = parseFrontmatter(original);
    const reserialized = serializeFrontmatter(frontmatter, body);
    const { frontmatter: roundTripped } = parseFrontmatter(reserialized);
    expect(roundTripped.created).toBe("2026-05-22");
    expect(roundTripped.updated).toBe("2026-05-22");
  });

  it("other scalar types still parse correctly under JSON_SCHEMA", () => {
    const { frontmatter } = parseFrontmatter(
      [
        "---",
        "created: 2026-05-22",
        "updated: 2026-05-22",
        "type: projects",
        "title: T",
        "confidence: 0.8",
        "tags: [alpha, beta]",
        "relations:",
        "  uses: [typescript, vitest]",
        "---",
        "body",
      ].join("\n"),
    );

    expect(frontmatter.confidence).toBe(0.8);
    expect(typeof frontmatter.confidence).toBe("number");
    expect(frontmatter.tags).toEqual(["alpha", "beta"]);
    expect(frontmatter.relations).toEqual({
      uses: ["typescript", "vitest"],
    });
  });
});
