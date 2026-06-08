import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyField } from "../../src/dashboard-ui/components/ApiKeyField.js";

const mutate = vi.fn();
vi.mock("../../src/dashboard-ui/hooks/useSecrets.js", () => ({
  useSecrets: () => ({ data: { VOYAGE_API_KEY: { present: true, last4: "wxyz" } } }),
  useUpdateSecret: () => ({ mutate, isPending: false, error: null }),
}));

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
    expect(mutate).toHaveBeenCalledWith({ provider: "openai", key: "sk-test" });
  });
});
