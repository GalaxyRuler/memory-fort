import { describe, expect, it } from "vitest";
import { observedDateFromAgentMemoryKey, uuidv7ToTimestamp } from "../../src/migration/uuidv7-timestamp.js";

describe("uuidv7 timestamp decoding", () => {
  it("decodes the unix-milliseconds timestamp from a UUIDv7", () => {
    const date = uuidv7ToTimestamp("019e45fc-5e01-7180-9f0c-114a3b1f941a");

    expect(date?.toISOString()).toBe("2026-05-20T15:23:47.585Z");
  });

  it("returns null for malformed and non-v7 UUIDs", () => {
    expect(uuidv7ToTimestamp("not-a-uuid")).toBeNull();
    expect(uuidv7ToTimestamp("019e45fc-5e01-4180-9f0c-114a3b1f941a")).toBeNull();
  });

  it("extracts observed dates from agentmemory observation keys only", () => {
    expect(observedDateFromAgentMemoryKey("mem:obs:019e45fc-5e01-7180-9f0c-114a3b1f941a")).toBe("2026-05-20");
    expect(observedDateFromAgentMemoryKey("mem:semantic:019e455f-9780-7ae2-9ce5-76a5683fe493")).toBe("2026-05-20");
    expect(observedDateFromAgentMemoryKey("mem:obs:not-a-uuid")).toBeNull();
    expect(observedDateFromAgentMemoryKey("other:obs:019e45fc-5e01-7180-9f0c-114a3b1f941a")).toBeNull();
  });
});
