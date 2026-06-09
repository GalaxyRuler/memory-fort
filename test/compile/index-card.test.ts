import { describe, it, expect, vi } from "vitest";
import { generateIndexCard, type IndexCard } from "../../src/compile/index-card.js";

describe("generateIndexCard", () => {
  it("returns a valid IndexCard from LLM output", async () => {
    const llmResponse = JSON.stringify({
      topics: ["retrieval-pipeline", "BM25", "embedding-refresh"],
      quotes: [
        { text: "The spreading activation decay is 0.6", start_byte: 100, end_byte: 140 },
      ],
      summary: "User debugged embedding refresh in the retrieval pipeline.",
    });

    const card = await generateIndexCard({
      rawPath: "raw/2026-06-09/codex-session.md",
      rawContent: "Some raw session content about retrieval and BM25 and embedding refresh.",
      llm: {
        complete: vi.fn().mockResolvedValue(llmResponse),
      },
      now: new Date(Date.UTC(2026, 5, 9, 14, 30, 0)),
    });

    expect(card.schema_version).toBe(1);
    expect(card.raw_path).toBe("raw/2026-06-09/codex-session.md");
    expect(card.raw_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(card.topics).toContain("retrieval-pipeline");
    expect(card.quotes).toHaveLength(1);
    expect(card.quotes[0].start_byte).toBe(100);
    expect(card.summary).toContain("retrieval pipeline");
    expect(card.generated_at).toBe("2026-06-09T14:30:00.000Z");
    expect(card.model).toBeTruthy();
  });

  it("handles LLM returning no quotes gracefully", async () => {
    const llmResponse = JSON.stringify({
      topics: ["misc"],
      quotes: [],
      summary: "A session about miscellaneous topics.",
    });

    const card = await generateIndexCard({
      rawPath: "raw/2026-06-09/codex-session.md",
      rawContent: "Some content.",
      llm: { complete: vi.fn().mockResolvedValue(llmResponse) },
      now: new Date(Date.UTC(2026, 5, 9)),
    });

    expect(card.quotes).toEqual([]);
    expect(card.topics).toEqual(["misc"]);
  });
});
