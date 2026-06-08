import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyField } from "../../src/dashboard-ui/components/ApiKeyField.js";

// Module-level mock: factory is hoisted, so mutate must be defined at module scope.
const mutate = vi.fn();

vi.mock("../../src/dashboard-ui/hooks/useSecrets.js", () => ({
  useSecrets: () => ({ data: { VOYAGE_API_KEY: { present: true, last4: "wxyz" } } }),
  useUpdateSecret: () => ({ mutate, isPending: false, error: null }),
}));

beforeEach(() => {
  mutate.mockReset();
});

function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("ApiKeyField", () => {
  it("shows masked last4 when a key is present", () => {
    wrap(<ApiKeyField provider="voyage" envVar="VOYAGE_API_KEY" label="Voyage API key" />);
    expect(screen.getByText(/wxyz/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replace/i })).toBeInTheDocument();
  });

  it("submits a new key via the mutation", () => {
    wrap(<ApiKeyField provider="openai" envVar="OPENAI_API_KEY" label="OpenAI API key" />);
    fireEvent.change(screen.getByLabelText(/openai api key/i), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));
    expect(mutate.mock.calls[0][0]).toEqual({ provider: "openai", key: "sk-test" });
  });

  it("clears the input after a successful save", () => {
    // Make mutate call onSuccess synchronously so the cleanup runs during the test.
    mutate.mockImplementation((_body, opts) => opts?.onSuccess?.());

    wrap(<ApiKeyField provider="openai" envVar="OPENAI_API_KEY" label="OpenAI API key" />);
    const input = screen.getByLabelText(/openai api key/i);
    fireEvent.change(input, { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));
    expect((input as HTMLInputElement).value).toBe("");
  });
});
