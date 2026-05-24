import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SettingsField } from "../../../src/dashboard-ui/components/SettingsField.js";
import { SettingsPage } from "../../../src/dashboard-ui/components/SettingsPage.js";
import { SettingsSection } from "../../../src/dashboard-ui/components/SettingsSection.js";

const configHook = vi.hoisted(() => ({
  useConfig: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useConfig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useConfig.js")>();
  return {
    ...actual,
    useConfig: configHook.useConfig,
  };
});

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("settings page", () => {
  beforeEach(() => {
    configHook.useConfig.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("useConfig fetches /api/config", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ retention: { raw_window_days: 90 } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const actual = await vi.importActual<typeof import("../../../src/dashboard-ui/hooks/useConfig.js")>(
      "../../../src/dashboard-ui/hooks/useConfig.js",
    );

    function ConfigProbe() {
      const config = actual.useConfig();
      if (config.isLoading) return <p>loading</p>;
      if (config.isError) return <p>error</p>;
      return <p>raw window: {String(config.data.retention?.raw_window_days)}</p>;
    }

    renderWithQueryClient(<ConfigProbe />);

    await waitFor(() => {
      expect(screen.getByText("raw window: 90")).toBeInTheDocument();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/memory/api/config");
  });

  test("SettingsField formats primitive and array values", () => {
    render(
      <dl>
        <SettingsField label="string_value" value="hello" />
        <SettingsField label="number_value" value={42} />
        <SettingsField label="boolean_value" value={true} />
        <SettingsField label="null_value" value={null} />
        <SettingsField label="array_value" value={["a", "b"]} />
      </dl>,
    );

    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText("(unset)")).toBeInTheDocument();
    expect(screen.getByText("a, b")).toBeInTheDocument();
  });

  test("SettingsField shows a redacted indicator with amber styling", () => {
    const { container } = render(
      <dl>
        <SettingsField label="api_key" value="[REDACTED]" />
      </dl>,
    );

    expect(screen.getByText("[REDACTED]")).toHaveClass("text-status-amber");
    expect(container.querySelector("svg.text-status-amber")).not.toBeNull();
  });

  test("SettingsSection renders all keys from the data object", () => {
    render(<SettingsSection title="sample" data={{ a: 1, b: "x", c: true }} />);

    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
  });

  test("SettingsPage renders sections from config", () => {
    configHook.useConfig.mockReturnValue({
      data: {
        retention: { raw_window_days: 90 },
        embedding: { provider: "voyage", model: "voyage-4-large" },
      },
      error: null,
      isLoading: false,
    });

    render(<SettingsPage />);

    expect(screen.getByRole("heading", { name: "retention" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "embedding" })).toBeInTheDocument();
    expect(screen.getByText("raw_window_days")).toBeInTheDocument();
    expect(screen.getByText("provider")).toBeInTheDocument();
    expect(screen.getByText("voyage-4-large")).toBeInTheDocument();
  });
});
