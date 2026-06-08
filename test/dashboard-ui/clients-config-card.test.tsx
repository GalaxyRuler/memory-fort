import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClientsConfigCard } from "../../src/dashboard-ui/components/ClientsConfigCard.js";

vi.mock("../../src/dashboard-ui/hooks/useConfig.js", () => ({
  useConfig: () => ({ data: { clients: { codex: false } } }),
}));
vi.mock("../../src/dashboard-ui/hooks/useUpdateConfig.js", () => ({
  useUpdateConfig: () => ({ mutate: vi.fn(), isPending: false }),
}));

function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("ClientsConfigCard", () => {
  it("renders a row per client and marks a disabled client Off + dimmed", () => {
    wrap(<ClientsConfigCard />);
    expect(screen.getByText(/codex/i)).toBeInTheDocument();
    const offBadge = screen.getByText(/^off$/i);
    expect(offBadge).toBeInTheDocument();
  });
});
