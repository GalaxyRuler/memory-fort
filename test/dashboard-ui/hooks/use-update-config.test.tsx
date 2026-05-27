import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useUpdateConfig } from "../../../src/dashboard-ui/hooks/useUpdateConfig.js";

function renderWithClient(ui: ReactNode, client: QueryClient) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function Probe() {
  const mutation = useUpdateConfig();
  return (
    <button
      type="button"
      onClick={() => mutation.mutate({ llm: { provider: "ollama", model: "llama3.2" } })}
    >
      save
    </button>
  );
}

describe("useUpdateConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("PATCHes config and invalidates config plus providers queries", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderWithClient(<Probe />, client);
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/memory/api/config");
    expect(init).toMatchObject({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm: { provider: "ollama", model: "llama3.2" } }),
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["config"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["providers"] });
    });
  });
});
