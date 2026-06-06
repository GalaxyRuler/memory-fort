import { describe, expect, test } from "vitest";
import { decodeUuidV7Time } from "../../../src/dashboard-ui/lib/uuidv7.js";

describe("decodeUuidV7Time", () => {
  test("decodes the first 48 UUIDv7 bits as Unix milliseconds", () => {
    const decoded = decodeUuidV7Time("019e4bf7-d7b8-7a57-8000-000000000000");

    expect(decoded?.toISOString()).toBe("2026-05-21T19:16:34.360Z");
  });

  test("returns null for non-v7 and malformed IDs", () => {
    expect(decodeUuidV7Time("019e4bf7-d7b8-4a57-8000-000000000000")).toBeNull();
    expect(decodeUuidV7Time("not-a-uuid")).toBeNull();
  });
});
