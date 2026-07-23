import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, setDashboardAccessToken } from "../../src/dashboard-ui/lib/api.js";

describe("dashboard API token", () => {
  afterEach(() => {
    setDashboardAccessToken(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("adds a transient bearer header without persisting the token", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    setDashboardAccessToken("transient-dashboard-token");
    await expect(apiFetch("/memory/api/status")).resolves.toBeInstanceOf(Response);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer transient-dashboard-token");
  });

  it("clears the bearer header when the transient token is removed", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    setDashboardAccessToken("transient-dashboard-token");
    setDashboardAccessToken(undefined);
    await apiFetch("/memory/api/status");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });
});
