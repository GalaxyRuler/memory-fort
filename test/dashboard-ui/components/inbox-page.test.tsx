import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { InboxPage } from "../../../src/dashboard-ui/components/InboxPage.js";

const proposedHooks = vi.hoisted(() => ({
  useProposedThreads: vi.fn(),
  useProposedProcedures: vi.fn(),
  useProposedSummary: vi.fn(),
  useProposedAction: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useProposed.js", () => proposedHooks);

describe("InboxPage", () => {
  beforeEach(() => {
    proposedHooks.useProposedThreads.mockReset();
    proposedHooks.useProposedProcedures.mockReset();
    proposedHooks.useProposedSummary.mockReset();
    proposedHooks.useProposedAction.mockReset();
    proposedHooks.useProposedSummary.mockReturnValue({
      data: { total: 0, recentAutoPromoted: 2, threads: { total: 0, high: 0, low: 0 }, procedures: { total: 0, high: 0, low: 0 } },
    });
    proposedHooks.useProposedAction.mockReturnValue({
      mutate: vi.fn((_input, options) => options?.onSuccess?.()),
    });
  });

  test("renders thread and procedure lists", () => {
    proposedHooks.useProposedThreads.mockReturnValue({
      data: [
        {
          kind: "thread",
          slug: "thread-one",
          title: "Thread One",
          observationCount: 5,
          distinctSessions: 2,
          confidence: { level: "high", reasons: ["all signals clean"] },
          prosePreview: "Thread preview.",
          body: "Thread body",
          timeRange: { start: "2026-05-24", end: "2026-05-28" },
        },
      ],
      isLoading: false,
      error: null,
    });
    proposedHooks.useProposedProcedures.mockReturnValue({
      data: [
        {
          kind: "procedure",
          slug: "procedure-one",
          title: "Procedure One",
          observationCount: 3,
          distinctSessions: 1,
          confidence: { level: "low", reasons: ["observationCount=3 below threshold 5"] },
          prosePreview: "Procedure preview.",
          body: "Procedure body",
          commandSignature: [],
          steps: 2,
        },
      ],
      isLoading: false,
      error: null,
    });

    render(<InboxPage />);

    expect(screen.getByText("Thread One")).toBeInTheDocument();
    expect(screen.getByText("Procedure One")).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText(/Low confidence/)).toBeInTheDocument();
  });

  test("promote and reject fire the expected actions", () => {
    const mutate = vi.fn((_input, options) => options?.onSuccess?.());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    proposedHooks.useProposedAction.mockReturnValue({ mutate });
    proposedHooks.useProposedThreads.mockReturnValue({
      data: [
        {
          kind: "thread",
          slug: "thread-one",
          title: "Thread One",
          observationCount: 5,
          distinctSessions: 2,
          confidence: { level: "high", reasons: ["all signals clean"] },
          prosePreview: "Thread preview.",
          body: "Thread body",
          timeRange: null,
        },
      ],
      isLoading: false,
      error: null,
    });
    proposedHooks.useProposedProcedures.mockReturnValue({
      data: [
        {
          kind: "procedure",
          slug: "procedure-one",
          title: "Procedure One",
          observationCount: 3,
          distinctSessions: 1,
          confidence: { level: "low", reasons: ["observationCount=3 below threshold 5"] },
          prosePreview: "Procedure preview.",
          body: "Procedure body",
          commandSignature: [],
          steps: 2,
        },
      ],
      isLoading: false,
      error: null,
    });

    render(<InboxPage />);

    fireEvent.click(screen.getAllByRole("button", { name: /promote/i })[0]!);
    expect(mutate).toHaveBeenCalledWith(
      { action: "promote", kind: "thread", slug: "thread-one" },
      expect.any(Object),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /reject/i })[0]!);
    expect(mutate).toHaveBeenCalledWith(
      { action: "reject", kind: "procedure", slug: "procedure-one" },
      expect.any(Object),
    );
  });

  test("shows empty state with recent auto-promote count", () => {
    proposedHooks.useProposedThreads.mockReturnValue({ data: [], isLoading: false, error: null });
    proposedHooks.useProposedProcedures.mockReturnValue({ data: [], isLoading: false, error: null });

    render(<InboxPage />);

    expect(screen.getByText("Inbox zero")).toBeInTheDocument();
    expect(screen.getByText("Auto-promote handled 2 drafts in the last 7 days.")).toBeInTheDocument();
  });
});
