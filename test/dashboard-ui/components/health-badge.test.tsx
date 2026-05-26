import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HealthBadge } from "../../../src/dashboard-ui/components/HealthBadge.js";
import { useHealth, type VerifyReport } from "../../../src/dashboard-ui/hooks/useHealth.js";

vi.mock("../../../src/dashboard-ui/hooks/useHealth.js", () => ({
  useHealth: vi.fn(),
}));

const mockUseHealth = vi.mocked(useHealth);

describe("HealthBadge", () => {
  it("renders a compact all-healthy state", () => {
    mockUseHealth.mockReturnValue(query(allPassReport()));

    render(<HealthBadge />);

    expect(screen.getByText("All systems connected")).toBeInTheDocument();
    expect(screen.getByText("2 checks")).toBeInTheDocument();
  });

  it("renders warning and failure counts in compact mode", () => {
    mockUseHealth.mockReturnValue(query(mixedReport()));

    render(<HealthBadge />);

    expect(screen.getByText("1 failure")).toBeInTheDocument();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
  });

  it("expands to show check details and suggested fixes", () => {
    mockUseHealth.mockReturnValue(query(mixedReport()));

    render(<HealthBadge />);
    fireEvent.click(screen.getByRole("button", { name: /memory health/i }));

    expect(screen.getByText("claude-code plugin enabled")).toBeInTheDocument();
    expect(screen.getByText("no capture file from the last 24h")).toBeInTheDocument();
    expect(screen.getByText("run `memory connect claude-code`")).toBeInTheDocument();
  });
});

function query(data: VerifyReport): ReturnType<typeof useHealth> {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof useHealth>;
}

function allPassReport(): VerifyReport {
  return {
    startedAt: "2026-05-26T03:30:00.000Z",
    finishedAt: "2026-05-26T03:30:01.000Z",
    overallStatus: "pass",
    checks: [
      { id: "vault.read-write", label: "vault read/write", status: "pass", durationMs: 2 },
      { id: "git.remote", label: "git remote reachable", status: "pass", durationMs: 5 },
    ],
  };
}

function mixedReport(): VerifyReport {
  return {
    startedAt: "2026-05-26T03:30:00.000Z",
    finishedAt: "2026-05-26T03:30:02.000Z",
    overallStatus: "fail",
    checks: [
      {
        id: "client.claude-code.enabled",
        label: "claude-code plugin enabled",
        status: "fail",
        detail: "plugin is not enabled",
        suggestedFix: "run `memory connect claude-code`",
        durationMs: 8,
      },
      {
        id: "client.claude-code.capture",
        label: "claude-code captures today",
        status: "warn",
        detail: "no capture file from the last 24h",
        suggestedFix: "run `memory backfill --from claude-code`",
        durationMs: 4,
      },
      { id: "vault.read-write", label: "vault read/write", status: "pass", durationMs: 1 },
    ],
  };
}
