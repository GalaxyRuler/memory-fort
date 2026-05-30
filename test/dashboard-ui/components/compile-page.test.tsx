import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CompilePage } from "../../../src/dashboard-ui/components/CompilePage.js";

const compileHook = vi.hoisted(() => ({
  useCompileState: vi.fn(),
  useRunCompileNow: vi.fn(),
}));
const statusHook = vi.hoisted(() => ({
  useStatus: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useCompileState.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useCompileState.js")>();
  return {
    ...actual,
    useCompileState: compileHook.useCompileState,
    useRunCompileNow: compileHook.useRunCompileNow,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useStatus.js", () => ({
  useStatus: statusHook.useStatus,
}));

describe("CompilePage", () => {
  function renderIdle(overrides: Record<string, unknown> = {}) {
    compileHook.useCompileState.mockReturnValue({
      data: {
        status: "idle",
        lastRun: null,
        execute: { available: true, reason: null },
        ...overrides,
      },
      isLoading: false,
      isError: false,
    });
  }

  beforeEach(() => {
    compileHook.useCompileState.mockReset();
    compileHook.useRunCompileNow.mockReset();
    statusHook.useStatus.mockReset();
    statusHook.useStatus.mockReturnValue({
      data: { capabilities: { writable: true } },
      isLoading: false,
      error: null,
    });
    compileHook.useRunCompileNow.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      data: null,
      error: null,
    });
  });

  test("does not render decorative mock node identifiers", () => {
    renderIdle();

    render(<CompilePage />);

    expect(screen.queryAllByText(/node_[0-9a-f]+/i)).toHaveLength(0);
  });

  test("confirms and runs compile in execute mode from the primary button", () => {
    const mutate = vi.fn();
    renderIdle();
    compileHook.useRunCompileNow.mockReturnValue({
      mutate,
      isPending: false,
      data: null,
      error: null,
    });

    render(<CompilePage />);
    fireEvent.click(screen.getAllByRole("button", { name: /run compile now/i })[0]);

    expect(screen.getByRole("dialog", { name: "Run compile?" })).toBeInTheDocument();
    expect(screen.getByText(/This sends recent raw observations to the LLM/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Run compile$/i }));

    expect(mutate).toHaveBeenCalledWith({ execute: true });
  });

  test("surfaces execute summaries and links staged changes to the inbox", () => {
    renderIdle();
    compileHook.useRunCompileNow.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      data: {
        ok: true,
        summary: {
          execute: true,
          rawIncluded: 101,
          rawSkipped: 4,
          rawRemaining: 1038,
          opsApplied: 8,
          opsStaged: 2,
          opsRejected: 1,
          outcomes: [
            { path: "wiki/projects/iaqar.md", outcome: "created", contentPreserved: true },
            {
              path: "wiki/lessons/thin.md",
              outcome: "staged-for-review",
              reason: "low confidence",
              contentPreserved: true,
            },
            {
              path: "wiki/unknowns/bad.md",
              outcome: "rejected",
              reason: "unknown wiki page category: unknowns",
              contentPreserved: false,
            },
          ],
          referencesStripped: 1,
          outputPath: "state/scheduled-compile-prompt.md",
        },
      },
      error: null,
    });

    render(<CompilePage />);

    expect(screen.getByText(/Consolidated 101 observations/i)).toBeInTheDocument();
    expect(screen.getByText(/8 applied/i)).toBeInTheDocument();
    expect(screen.getByText(/2 staged for review/i)).toBeInTheDocument();
    expect(screen.getByText(/1 rejected/i)).toBeInTheDocument();
    expect(screen.getByText("wiki/projects/iaqar.md")).toBeInTheDocument();
    expect(screen.getByText(/unknown wiki page category: unknowns/)).toBeInTheDocument();
    expect(screen.getByText(/1,038 observations remaining/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review 2 staged changes/i })).toHaveAttribute("href", "/memory/inbox");
  });

  test("shows the already-running message for a 409 compile error", () => {
    renderIdle();
    compileHook.useRunCompileNow.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      data: null,
      error: new Error("compile already running"),
    });

    render(<CompilePage />);

    expect(screen.getByText(/a compile is already running/i)).toBeInTheDocument();
  });

  test("disables execute action when LLM execution is unavailable", () => {
    renderIdle({
      execute: { available: false, reason: "LLM access disabled by MEMORY_LLM_DISABLED=true" },
    });

    render(<CompilePage />);

    const primary = screen.getAllByRole("button", { name: /run compile now/i })[0];
    expect(primary).toBeDisabled();
    expect(primary).toHaveAttribute("title", "LLM access disabled by MEMORY_LLM_DISABLED=true");
  });

  test("keeps prompt-only artifact mode as a secondary action", () => {
    const mutate = vi.fn();
    renderIdle();
    compileHook.useRunCompileNow.mockReturnValue({
      mutate,
      isPending: false,
      data: null,
      error: null,
    });

    render(<CompilePage />);
    fireEvent.click(screen.getByRole("button", { name: /generate prompt only/i }));

    expect(mutate).toHaveBeenCalledWith({ execute: false });
  });

  test("disables execute actions but keeps prompt-only mode on a read-only mirror", () => {
    const mutate = vi.fn();
    renderIdle();
    compileHook.useRunCompileNow.mockReturnValue({
      mutate,
      isPending: false,
      data: null,
      error: null,
    });
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

    render(<CompilePage />);

    expect(screen.getByText(/read-only mirror/i)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: /run compile now/i })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "read-only mirror — run `memory dashboard` on your machine to make changes");
    }
    fireEvent.click(screen.getByRole("button", { name: /generate prompt only/i }));
    expect(mutate).toHaveBeenCalledWith({ execute: false });
  });
});
