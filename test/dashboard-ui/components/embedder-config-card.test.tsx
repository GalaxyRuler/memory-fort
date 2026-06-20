import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { EmbedderConfigCard } from "../../../src/dashboard-ui/components/EmbedderConfigCard.js";

const hooks = vi.hoisted(() => ({
  useConfig: vi.fn(),
  useProvidersCatalog: vi.fn(),
  useUpdateConfig: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useConfig.js", () => ({ useConfig: hooks.useConfig }));
vi.mock("../../../src/dashboard-ui/hooks/useProvidersCatalog.js", () => ({ useProvidersCatalog: hooks.useProvidersCatalog }));
vi.mock("../../../src/dashboard-ui/hooks/useUpdateConfig.js", () => ({ useUpdateConfig: hooks.useUpdateConfig }));
vi.mock("../../../src/dashboard-ui/hooks/useSecrets.js", () => ({
  useSecrets: () => ({ data: {}, isLoading: false, error: null }),
  useUpdateSecret: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

describe("EmbedderConfigCard", () => {
  beforeEach(() => {
    hooks.useConfig.mockReturnValue({
      data: { embedder: { provider: "voyage", model: "voyage-4-large" } },
      isLoading: false,
      error: null,
    });
    hooks.useProvidersCatalog.mockReturnValue({
      data: {
        embedders: [
          {
            provider: "voyage",
            envVar: "VOYAGE_API_KEY",
            envVarStatus: "set",
            models: [{ id: "voyage-4-large", dim: 2048, default: true }],
          },
          {
            provider: "openai",
            envVar: "OPENAI_API_KEY",
            envVarStatus: "missing",
            models: [{ id: "text-embedding-3-small", dim: 1536, default: true }],
          },
          {
            provider: "openai-compat",
            envVar: "none",
            envVarStatus: "set",
            models: [{ id: "nomic-embed-text", dim: 768, default: true }],
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    hooks.useUpdateConfig.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  });

  test("switches provider, auto-defaults model, and saves only embedder fields", () => {
    const mutation = { mutate: vi.fn(), isPending: false, error: null };
    hooks.useUpdateConfig.mockReturnValue(mutation);

    render(<EmbedderConfigCard />);

    expect(screen.getByText("Provider: voyage")).toBeInTheDocument();
    expect(screen.getByText("VOYAGE_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("[REDACTED — set]")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /edit embedder/i }));
    fireEvent.change(screen.getByLabelText("Embedder provider"), { target: { value: "openai" } });

    expect(screen.getByLabelText("Embedder model")).toHaveValue("text-embedding-3-small");
    expect(screen.getByText("[not configured]")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save embedder changes/i }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      { embedder: { provider: "openai", model: "text-embedding-3-small" } },
      expect.any(Object),
    );
  });

  test("saves openai-compatible endpoint settings without an API key field", () => {
    const mutation = { mutate: vi.fn(), isPending: false, error: null };
    hooks.useConfig.mockReturnValue({
      data: {
        embedder: {
          provider: "openai-compat",
          model: "nomic-embed-text",
          options: { baseURL: "http://127.0.0.1:11434/v1", dim: 768 },
        },
      },
      isLoading: false,
      error: null,
    });
    hooks.useUpdateConfig.mockReturnValue(mutation);

    render(<EmbedderConfigCard />);

    fireEvent.click(screen.getByRole("button", { name: /edit embedder/i }));
    expect(screen.queryByLabelText("OpenAI-compat API key")).toBeNull();
    fireEvent.change(screen.getByLabelText("OpenAI-compat base URL"), {
      target: { value: "http://127.0.0.1:11435/v1" },
    });
    fireEvent.change(screen.getByLabelText("Embedding dimension"), { target: { value: "1024" } });
    fireEvent.click(screen.getByRole("button", { name: /save embedder changes/i }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      {
        embedder: {
          provider: "openai-compat",
          model: "nomic-embed-text",
          options: { baseURL: "http://127.0.0.1:11435/v1", dim: 1024 },
          allow_internal_hosts: true,
        },
      },
      expect.any(Object),
    );
  });
});
