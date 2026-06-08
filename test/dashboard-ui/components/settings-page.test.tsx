import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SettingsField } from "../../../src/dashboard-ui/components/SettingsField.js";
import { SettingsPage } from "../../../src/dashboard-ui/components/SettingsPage.js";
import { SettingsSection } from "../../../src/dashboard-ui/components/SettingsSection.js";

const configHook = vi.hoisted(() => ({
  useConfig: vi.fn(),
}));

const providerHook = vi.hoisted(() => ({
  useProvidersCatalog: vi.fn(),
}));

const updateHook = vi.hoisted(() => ({
  useUpdateConfig: vi.fn(),
}));
const statusHook = vi.hoisted(() => ({
  useStatus: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useConfig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useConfig.js")>();
  return {
    ...actual,
    useConfig: configHook.useConfig,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useProvidersCatalog.js", () => ({
  useProvidersCatalog: providerHook.useProvidersCatalog,
}));

vi.mock("../../../src/dashboard-ui/hooks/useUpdateConfig.js", () => ({
  useUpdateConfig: updateHook.useUpdateConfig,
}));

vi.mock("../../../src/dashboard-ui/hooks/useStatus.js", () => ({
  useStatus: statusHook.useStatus,
}));

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("settings page", () => {
  beforeEach(() => {
    configHook.useConfig.mockReset();
    providerHook.useProvidersCatalog.mockReset();
    updateHook.useUpdateConfig.mockReset();
    statusHook.useStatus.mockReset();
    statusHook.useStatus.mockReturnValue({
      data: { capabilities: { writable: true } },
      isLoading: false,
      error: null,
    });
    providerHook.useProvidersCatalog.mockReturnValue({
      data: {
        embedders: [
          {
            provider: "voyage",
            envVar: "VOYAGE_API_KEY",
            envVarStatus: "missing",
            models: [{ id: "voyage-4-large", dim: 2048, default: true }],
          },
        ],
        llms: [
          {
            provider: "openrouter",
            envVar: "OPENROUTER_API_KEY",
            envVarStatus: "missing",
            models: [{ id: "openai/gpt-4o-mini", default: true }],
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    updateHook.useUpdateConfig.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
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

  test("SettingsSection humanizes retention labels and keeps raw keys discoverable", () => {
    render(
      <SettingsSection
        title="retention"
        data={{
          raw_window_days: 90,
          raw_compile_before_delete: true,
          embeddings_prune_with_raw: true,
          wiki_status_stale_days: 180,
          crystals_never_auto_delete: true,
        }}
      />,
    );

    expect(screen.getByText("Keep raw sessions for 90 days")).toBeInTheDocument();
    expect(screen.getByText("Compile before deleting raw sessions: Yes")).toBeInTheDocument();
    expect(screen.getByText("Prune embeddings with raw sessions: Yes")).toBeInTheDocument();
    expect(screen.getByText("Mark wiki pages stale after 180 days")).toBeInTheDocument();
    expect(screen.getByText("Never auto-delete crystals: Yes")).toBeInTheDocument();

    expect(screen.getByText("raw_window_days")).toBeInTheDocument();
    expect(screen.getByText("raw_compile_before_delete")).toBeInTheDocument();
    expect(screen.getByText("embeddings_prune_with_raw")).toBeInTheDocument();
    expect(screen.getByText("wiki_status_stale_days")).toBeInTheDocument();
    expect(screen.getByText("crystals_never_auto_delete")).toBeInTheDocument();
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
    expect(screen.queryByRole("heading", { name: "embedding" })).not.toBeInTheDocument();
    expect(screen.getByText("Keep raw sessions for 90 days")).toBeInTheDocument();
    expect(screen.getByText("raw_window_days")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Embedder provider" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Embedder model" })).toBeVisible();
  });

  test("SettingsPage renders editable provider cards above read-only sections", () => {
    configHook.useConfig.mockReturnValue({
      data: {
        embedder: { provider: "voyage", model: "voyage-4-large" },
        llm: { provider: "openrouter", model: "openai/gpt-4o-mini" },
        retention: { raw_window_days: 90 },
      },
      error: null,
      isLoading: false,
    });

    render(<SettingsPage />);

    expect(screen.getByRole("heading", { name: "Embedder" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LLM" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "embedder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "llm" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "LLM provider" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "LLM model" })).toBeVisible();
    expect(screen.getByRole("button", { name: /edit embedder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit llm/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "retention" })).toBeInTheDocument();
    expect(screen.getByText(/Provider settings .* can now be edited directly/i)).toBeInTheDocument();
  });

  test("SettingsPage renders auto-promote and compile controls and patches safelisted fields", () => {
    const mutate = vi.fn();
    configHook.useConfig.mockReturnValue({
      data: {
        auto_promote: { enabled: false, cadence: "weekly", confidence_threshold: "high" },
        compile: { scheduled: true, cadence: "daily" },
      },
      error: null,
      isLoading: false,
    });
    updateHook.useUpdateConfig.mockReturnValue({ mutate, isPending: false, error: null });

    render(<SettingsPage />);

    expect(screen.getByRole("heading", { name: "Auto-promote" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Compile" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /enable auto-promote/i }));
    expect(mutate).toHaveBeenCalledWith({ auto_promote: { enabled: true } });

    fireEvent.click(screen.getAllByRole("radio", { name: "daily" })[0]!);
    expect(mutate).toHaveBeenCalledWith({ auto_promote: { cadence: "daily" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /schedule compile/i }));
    expect(mutate).toHaveBeenCalledWith({ compile: { scheduled: false } });
    expect(screen.queryByRole("heading", { name: "auto_promote" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "compile" })).not.toBeInTheDocument();
  });

  test("SettingsPage disables config edits on a read-only mirror", () => {
    const mutate = vi.fn();
    configHook.useConfig.mockReturnValue({
      data: {
        embedder: { provider: "voyage", model: "voyage-4-large" },
        llm: { provider: "openrouter", model: "openai/gpt-4o-mini" },
        auto_promote: { enabled: false, cadence: "weekly" },
        compile: { scheduled: true, cadence: "daily" },
      },
      error: null,
      isLoading: false,
    });
    updateHook.useUpdateConfig.mockReturnValue({ mutate, isPending: false, error: null });
    statusHook.useStatus.mockReturnValue({
      data: {
        capabilities: {
          writable: false,
          reason: "read-only mirror — run `memory dashboard` on your machine to make changes",
        },
      },
      isLoading: false,
      error: null,
    });

    render(<SettingsPage />);

    expect(screen.getByText(/read-only mirror/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit embedder/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /edit llm/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /enable auto-promote/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /schedule compile/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /schedule compile/i }));
    expect(mutate).not.toHaveBeenCalled();
  });
});
