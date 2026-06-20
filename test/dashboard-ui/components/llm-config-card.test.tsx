import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { LLMConfigCard } from "../../../src/dashboard-ui/components/LLMConfigCard.js";

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

describe("LLMConfigCard", () => {
  beforeEach(() => {
    hooks.useConfig.mockReturnValue({
      data: { llm: { provider: "openrouter", model: "openai/gpt-4o-mini", max_tokens: 4096, temperature: 0.2 } },
      isLoading: false,
      error: null,
    });
    hooks.useProvidersCatalog.mockReturnValue({
      data: {
        llms: [
          {
            provider: "openrouter",
            envVar: "OPENROUTER_API_KEY",
            envVarStatus: "set",
            models: [{ id: "openai/gpt-4o-mini", default: true }],
          },
          {
            provider: "ollama",
            envVar: "OLLAMA_HOST",
            envVarStatus: "set",
            models: [{ id: "llama3.2", default: true }],
          },
          {
            provider: "openai-compat",
            envVar: "none",
            envVarStatus: "set",
            models: [{ id: "llama3.2", default: true }],
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    hooks.useUpdateConfig.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  });

  test("edits provider, model, max tokens, and temperature", () => {
    const mutation = { mutate: vi.fn(), isPending: false, error: null };
    hooks.useUpdateConfig.mockReturnValue(mutation);

    render(<LLMConfigCard />);

    expect(screen.getByText("Provider: openrouter")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /edit llm/i }));
    fireEvent.change(screen.getByLabelText("LLM provider"), { target: { value: "ollama" } });
    fireEvent.change(screen.getByLabelText("LLM max tokens"), { target: { value: "1024" } });
    fireEvent.change(screen.getByLabelText("LLM temperature"), { target: { value: "0.7" } });

    expect(screen.getByLabelText("LLM model")).toHaveValue("llama3.2");
    fireEvent.click(screen.getByRole("button", { name: /save llm changes/i }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      { llm: { provider: "ollama", model: "llama3.2", max_tokens: 1024, temperature: 0.7 } },
      expect.any(Object),
    );
  });

  test("saves openai-compatible endpoint settings without an API key field", () => {
    const mutation = { mutate: vi.fn(), isPending: false, error: null };
    hooks.useConfig.mockReturnValue({
      data: {
        llm: {
          provider: "openai-compat",
          model: "llama3.2",
          max_tokens: 2048,
          temperature: 0.2,
          options: { baseURL: "http://127.0.0.1:11434/v1" },
        },
      },
      isLoading: false,
      error: null,
    });
    hooks.useUpdateConfig.mockReturnValue(mutation);

    render(<LLMConfigCard />);

    fireEvent.click(screen.getByRole("button", { name: /edit llm/i }));
    expect(screen.queryByLabelText("OpenAI-compat API key")).toBeNull();
    fireEvent.change(screen.getByLabelText("OpenAI-compat base URL"), {
      target: { value: "http://127.0.0.1:11435/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save llm changes/i }));

    expect(mutation.mutate).toHaveBeenCalledWith(
      {
        llm: {
          provider: "openai-compat",
          model: "llama3.2",
          max_tokens: 2048,
          temperature: 0.2,
          options: { baseURL: "http://127.0.0.1:11435/v1" },
          allow_internal_hosts: true,
        },
      },
      expect.any(Object),
    );
  });
});
