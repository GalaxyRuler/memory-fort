import { describe, it, expect, vi } from "vitest";
import { generateIndexCard, isCardStale, loadIndexCard, type IndexCard } from "../../src/compile/index-card.js";
import { createHash } from "node:crypto";

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

  it("redacts secrets from quotes", async () => {
    const llmResponse = JSON.stringify({
      topics: ["config"],
      quotes: [
        { text: "API_KEY=sk-supersecretkey12345678", start_byte: 0, end_byte: 40 },
      ],
      summary: "User set API key.",
    });

    const card = await generateIndexCard({
      rawPath: "raw/2026-06-09/session.md",
      rawContent: "API_KEY=sk-supersecretkey12345678 in the config",
      llm: { complete: vi.fn().mockResolvedValue(llmResponse) },
    });

    expect(card.quotes[0].text).not.toContain("sk-supersecretkey12345678");
    expect(card.quotes[0].text).toContain("[REDACTED]");
  });

  it("redacts secrets from the raw content sent to LLM", async () => {
    let capturedPrompt = "";
    const card = await generateIndexCard({
      rawPath: "raw/2026-06-09/session.md",
      rawContent: "Bearer eyJhbGciOiJIUzI1NiJ9.secret-token",
      llm: {
        complete: vi.fn().mockImplementation((prompt: string) => {
          capturedPrompt = prompt;
          return Promise.resolve('{"topics":[],"quotes":[],"summary":"test"}');
        }),
      },
    });

    expect(capturedPrompt).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(capturedPrompt).toContain("[REDACTED]");
  });
});

describe("isCardStale", () => {
  it("returns false when sha256 matches", () => {
    const content = "raw session content";
    const sha = createHash("sha256").update(content).digest("hex");
    const card: IndexCard = {
      schema_version: 1,
      raw_path: "raw/2026-06-09/session.md",
      raw_sha256: sha,
      generated_at: "2026-06-09T14:30:00.000Z",
      model: "default",
      topics: ["test"],
      quotes: [],
      summary: "test",
    };
    expect(isCardStale(card, content)).toBe(false);
  });

  it("returns true when sha256 mismatches", () => {
    const card: IndexCard = {
      schema_version: 1,
      raw_path: "raw/2026-06-09/session.md",
      raw_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      generated_at: "2026-06-09T14:30:00.000Z",
      model: "default",
      topics: ["test"],
      quotes: [],
      summary: "test",
    };
    expect(isCardStale(card, "different content")).toBe(true);
  });
});

describe("loadIndexCard", () => {
  it("parses a valid JSON index card", () => {
    const json = JSON.stringify({
      schema_version: 1,
      raw_path: "raw/2026-06-09/session.md",
      raw_sha256: "abc123",
      generated_at: "2026-06-09T14:30:00.000Z",
      model: "gpt-4o-mini",
      topics: ["test"],
      quotes: [],
      summary: "A test session.",
    });
    const card = loadIndexCard(json);
    expect(card).not.toBeNull();
    expect(card!.schema_version).toBe(1);
    expect(card!.topics).toEqual(["test"]);
  });

  it("returns null for malformed JSON", () => {
    expect(loadIndexCard("not json")).toBeNull();
  });

  it("returns null for wrong schema_version", () => {
    const json = JSON.stringify({ schema_version: 99, raw_path: "x" });
    expect(loadIndexCard(json)).toBeNull();
  });
});
