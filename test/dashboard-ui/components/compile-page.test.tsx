import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CompilePage } from "../../../src/dashboard-ui/components/CompilePage.js";

const compileHook = vi.hoisted(() => ({
  useCompileState: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useCompileState.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useCompileState.js")>();
  return {
    ...actual,
    useCompileState: compileHook.useCompileState,
  };
});

describe("CompilePage", () => {
  beforeEach(() => {
    compileHook.useCompileState.mockReset();
  });

  test("does not render decorative mock node identifiers", () => {
    compileHook.useCompileState.mockReturnValue({
      data: {
        status: "idle",
        lastRun: null,
      },
      isLoading: false,
      isError: false,
    });

    render(<CompilePage />);

    expect(screen.queryAllByText(/node_[0-9a-f]+/i)).toHaveLength(0);
  });
});
