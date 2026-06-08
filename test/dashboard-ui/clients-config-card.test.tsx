import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClientsConfigCard } from "../../src/dashboard-ui/components/ClientsConfigCard.js";

// Mutable state shared across tests so individual tests can override per-call behaviour
let mockMutate = vi.fn();
let mockClients: Record<string, boolean> = { codex: false };

vi.mock("../../src/dashboard-ui/hooks/useConfig.js", () => ({
  useConfig: () => ({ data: { clients: mockClients } }),
}));
vi.mock("../../src/dashboard-ui/hooks/useUpdateConfig.js", () => ({
  useUpdateConfig: () => ({ mutate: mockMutate, isPending: false }),
}));

function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("ClientsConfigCard", () => {
  it("renders a row per client and marks a disabled client Off + dimmed", () => {
    mockClients = { codex: false };
    mockMutate = vi.fn();
    wrap(<ClientsConfigCard />);
    expect(screen.getByText(/codex/i)).toBeInTheDocument();
    const offBadge = screen.getByText(/^off$/i);
    expect(offBadge).toBeInTheDocument();
  });

  it("calls mutate with { clients: { 'claude-code': false } } when toggling an enabled client off", () => {
    mockClients = { codex: false };
    mockMutate = vi.fn();
    wrap(<ClientsConfigCard />);

    // claude-code is absent from the clients map → enabled = true, button reads "Turn off"
    const toggleBtn = screen.getByRole("switch", { name: /claude code/i });
    fireEvent.click(toggleBtn);

    expect(mockMutate).toHaveBeenCalledOnce();
    expect(mockMutate).toHaveBeenCalledWith({ clients: { "claude-code": false } });
  });

  it("shows no Off badge when all clients are enabled (empty clients map)", () => {
    mockClients = {};
    mockMutate = vi.fn();
    wrap(<ClientsConfigCard />);

    expect(screen.queryByText(/^off$/i)).toBeNull();
  });
});
