import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GOLD_TYPES = new Set(["fact", "causal", "temporal", "dependency", "provenance"]);

interface GoldQuestion {
  query: string;
  expected_paths: string[];
  type: string;
}

function parseJsonlLines<T>(raw: string): T[] {
  return raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

describe("graph-aware eval fixtures", () => {
  let entries: GoldQuestion[];

  beforeAll(async () => {
    const raw = await readFile(
      join(__dirname, "../../qa/graph-aware-gold.jsonl"),
      "utf-8",
    );
    entries = parseJsonlLines<GoldQuestion>(raw);
  });

  it("has at least 10 entries", () => {
    expect(entries.length).toBeGreaterThanOrEqual(10);
  });

  it("each entry has valid query, type, and expected_paths", () => {
    for (const [i, row] of entries.entries()) {
      expect(row.query, `row ${i} missing query`).toBeTruthy();
      expect(row.expected_paths.length, `row ${i} missing expected_paths`).toBeGreaterThan(0);
      for (const p of row.expected_paths) {
        expect(p.length, `row ${i} empty path`).toBeGreaterThan(0);
      }
      expect(GOLD_TYPES.has(row.type), `row ${i} invalid type: ${row.type}`).toBe(true);
    }
  });

  it("all expected_paths use wiki/ or crystals/ prefix", () => {
    for (const [i, row] of entries.entries()) {
      for (const p of row.expected_paths) {
        expect(
          p.startsWith("wiki/") || p.startsWith("crystals/"),
          `row ${i} path ${p} must start with wiki/ or crystals/`,
        ).toBe(true);
      }
    }
  });
});

const DISPATCH_TYPES = new Set(["duplicate", "contradiction", "supersession", "noop", "novel"]);

interface DispatchFixture {
  scenario: string;
  type: string;
  raw_content: string;
  existing_page?: string;
  existing_body?: string;
  expected_op: string;
}

describe("dispatch eval fixtures", () => {
  let entries: DispatchFixture[];

  beforeAll(async () => {
    const raw = await readFile(
      join(__dirname, "../../qa/dispatch-gold.jsonl"),
      "utf-8",
    );
    entries = parseJsonlLines<DispatchFixture>(raw);
  });

  it("has at least 8 entries", () => {
    expect(entries.length).toBeGreaterThanOrEqual(8);
  });

  it("each entry has valid scenario, type, raw_content, expected_op", () => {
    for (const [i, row] of entries.entries()) {
      expect(row.scenario, `row ${i} missing scenario`).toBeTruthy();
      expect(DISPATCH_TYPES.has(row.type), `row ${i} invalid type: ${row.type}`).toBe(true);
      expect(row.raw_content, `row ${i} missing raw_content`).toBeTruthy();
      expect(row.expected_op, `row ${i} missing expected_op`).toBeTruthy();
    }
  });

  it("contradiction and supersession fixtures have existing_page and existing_body", () => {
    for (const [i, row] of entries.entries()) {
      if (row.type === "contradiction" || row.type === "supersession") {
        expect(row.existing_page, `row ${i} (${row.type}) must have existing_page`).toBeTruthy();
        expect(row.existing_body, `row ${i} (${row.type}) must have existing_body`).toBeTruthy();
      }
    }
  });
});
