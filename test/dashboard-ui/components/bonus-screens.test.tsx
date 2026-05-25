import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CompilePage } from "../../../src/dashboard-ui/components/CompilePage.js";
import { ConflictsPage } from "../../../src/dashboard-ui/components/ConflictsPage.js";
import type { CompileState } from "../../../src/dashboard-ui/hooks/useCompileState.js";
import type { ConflictsResponse } from "../../../src/dashboard-ui/hooks/useConflicts.js";

const compileHook = vi.hoisted(() => ({
  useCompileState: vi.fn(),
}));

const conflictsHook = vi.hoisted(() => ({
  useConflicts: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useCompileState.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useCompileState.js")>();
  return {
    ...actual,
    useCompileState: compileHook.useCompileState,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useConflicts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useConflicts.js")>();
  return {
    ...actual,
    useConflicts: conflictsHook.useConflicts,
  };
});

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("bonus dashboard screens", () => {
  beforeEach(() => {
    compileHook.useCompileState.mockReset();
    conflictsHook.useConflicts.mockReset();
  });

  test("CompilePage renders the empty state when no compile run is recorded", () => {
    compileHook.useCompileState.mockReturnValue({
      data: { status: "idle", lastRun: null } satisfies CompileState,
      isError: false,
      isLoading: false,
    });

    renderWithQueryClient(<CompilePage />);

    expect(screen.getByText("No compile run recorded")).toBeInTheDocument();
  });

  test("ConflictsPage renders the empty-state copy when conflicts are empty", () => {
    conflictsHook.useConflicts.mockReturnValue({
      data: { conflicts: [] } satisfies ConflictsResponse,
      isError: false,
      isLoading: false,
    });

    renderWithQueryClient(<ConflictsPage />);

    expect(screen.getByText("No conflicts detected — your wiki is consistent.")).toBeInTheDocument();
  });

  test("ConflictsPage renders derived contradiction conflicts as indirect review items", () => {
    conflictsHook.useConflicts.mockReturnValue({
      data: {
        conflicts: [
          {
            id: "contradiction:a:b:dependent:projects/c.md",
            reason: "derived-from-contradiction",
            dependentPath: "wiki/projects/c.md",
            via: ["decisions/a.md:derived_from", "projects/c.md:linked"],
            rootContradictionId: "contradiction:a:b",
          },
        ],
      } satisfies ConflictsResponse,
      isError: false,
      isLoading: false,
    });

    renderWithQueryClient(<ConflictsPage />);

    expect(screen.getByText("Derived from contradiction")).toBeInTheDocument();
    expect(screen.getByText("indirect")).toBeInTheDocument();
    expect(screen.getByText("wiki/projects/c.md")).toBeInTheDocument();
    expect(screen.getByText("decisions/a.md:derived_from -> projects/c.md:linked")).toBeInTheDocument();
  });
});
