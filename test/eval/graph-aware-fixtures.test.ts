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
