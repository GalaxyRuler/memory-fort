import { describe, expect, it, vi } from "vitest";
import { validateKey } from "../../src/dashboard/secrets-validate.js";

function fakeFetch(status: number) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => "" })) as never;
}

describe("validateKey", () => {
  it("returns ok for a 200 from the provider", async () => {
    const r = await validateKey("voyage", "k", fakeFetch(200));
    expect(r.ok).toBe(true);
  });
  it("returns not-ok with a message for 401", async () => {
    const r = await validateKey("openai", "bad", fakeFetch(401));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/invalid|unauthor/i);
  });
  it("rejects an unknown provider", async () => {
    const r = await validateKey("mystery" as never, "k", fakeFetch(200));
    expect(r.ok).toBe(false);
  });
  it("hits the OpenRouter key endpoint with a GET", async () => {
    const f = fakeFetch(200);
    await validateKey("openrouter", "k", f);
    expect(f).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/auth/key",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
