import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { RawFilters } from "../../../src/dashboard-ui/components/RawFilters.js";
import { RawBrowsePage } from "../../../src/dashboard-ui/components/RawBrowsePage.js";
import { SessionRow } from "../../../src/dashboard-ui/components/SessionRow.js";
import {
  parseSessionIdFromFilename,
  parseSourceFromFilename,
} from "../../../src/dashboard-ui/lib/raw-helpers.js";

const routerState = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

const rawHook = vi.hoisted(() => ({
  useRawIndex: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    params,
    to,
  }: {
    children: ReactNode;
    className?: string;
    params?: Record<string, string>;
    to: string;
  }) => {
    const href = params ? to.replace("$date", params.date).replace("$filename", params.filename) : to;
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  },
  useNavigate: () => routerState.navigate,
  useSearch: () => routerState.search,
}));

vi.mock("../../../src/dashboard-ui/hooks/useRawIndex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useRawIndex.js")>();
  return {
    ...actual,
    useRawIndex: rawHook.useRawIndex,
  };
});

describe("raw page helpers and components", () => {
  beforeEach(() => {
    routerState.search = {};
    routerState.navigate.mockReset();
    rawHook.useRawIndex.mockReset();
  });

  test("parseSourceFromFilename classifies session sources", () => {
    expect(parseSourceFromFilename("claude-code-abc.md")).toBe("claude-code");
    expect(parseSourceFromFilename("codex-abc.md")).toBe("codex");
    expect(parseSourceFromFilename("antigravity-abc.md")).toBe("antigravity");
    expect(parseSourceFromFilename("claude-desktop-abc.md")).toBe("claude-desktop");
    expect(parseSourceFromFilename("manual-mcp-abc.md")).toBe("manual");
    expect(parseSourceFromFilename("mystery-abc.md")).toBe("unknown");
  });

  test("parseSessionIdFromFilename strips known prefixes and markdown extension", () => {
    expect(parseSessionIdFromFilename("claude-code-abc.md")).toBe("abc");
    expect(parseSessionIdFromFilename("codex-abc.md")).toBe("abc");
    expect(parseSessionIdFromFilename("antigravity-abc.md")).toBe("abc");
    expect(parseSessionIdFromFilename("manual-mcp-abc.md")).toBe("abc");
    expect(parseSessionIdFromFilename("manual-abc.md")).toBe("abc");
  });

  test("RawFilters fires onChange with the selected source", () => {
    const onChange = vi.fn();

    render(<RawFilters onChange={onChange} source="all" />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    expect(onChange).toHaveBeenCalledWith("codex");
  });

  test("SessionRow links to the raw session route and shows the source color", () => {
    const { container } = render(
      <SessionRow
        date="2026-05-24"
        file={{
          filename: "claude-code-019e4bf7-d7b8-4a57.md",
          mtime: "2026-05-24T12:00:00.000Z",
          sizeBytes: 2048,
        }}
      />,
    );

    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/raw/2026-05-24/claude-code-019e4bf7-d7b8-4a57.md",
    );
    expect(container.querySelector(".bg-entity-projects")).not.toBeNull();
  });

  test("RawBrowsePage starts at the URL page size and loads more", () => {
    routerState.search = { per: "2" };
    rawHook.useRawIndex.mockReturnValue({
      data: [
        {
          date: "2026-05-24",
          files: [
            { filename: "codex-alpha.md", mtime: "2026-05-24T10:00:00.000Z", sizeBytes: 100 },
            { filename: "codex-beta.md", mtime: "2026-05-24T11:00:00.000Z", sizeBytes: 100 },
            { filename: "codex-gamma.md", mtime: "2026-05-24T12:00:00.000Z", sizeBytes: 100 },
          ],
        },
      ],
      isLoading: false,
    });

    render(<RawBrowsePage />);

    expect(screen.getByText("Showing 2 of 3")).toBeInTheDocument();
    expect(screen.queryByText(/gamma/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more raw sessions/i }));

    expect(screen.getByText(/gamma/)).toBeInTheDocument();
  });

  test("RawBrowsePage exposes session rows as list items with nested links", () => {
    rawHook.useRawIndex.mockReturnValue({
      data: [
        {
          date: "2026-05-24",
          files: [{ filename: "codex-alpha.md", mtime: "2026-05-24T10:00:00.000Z", sizeBytes: 100 }],
        },
      ],
      isLoading: false,
    });

    render(<RawBrowsePage />);

    const list = screen.getByRole("list", { name: "Raw sessions on 2026-05-24" });
    const item = within(list).getByRole("listitem");

    expect(within(item).getByRole("link", { name: /codex-alpha/i })).toHaveAttribute(
      "href",
      "/raw/2026-05-24/codex-alpha.md",
    );
  });
});
