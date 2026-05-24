import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { RawFilters } from "../../../src/dashboard-ui/components/RawFilters.js";
import { SessionRow } from "../../../src/dashboard-ui/components/SessionRow.js";
import {
  parseSessionIdFromFilename,
  parseSourceFromFilename,
} from "../../../src/dashboard-ui/lib/raw-helpers.js";

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
}));

describe("raw page helpers and components", () => {
  test("parseSourceFromFilename classifies session sources", () => {
    expect(parseSourceFromFilename("claude-code-abc.md")).toBe("claude-code");
    expect(parseSourceFromFilename("codex-abc.md")).toBe("codex");
    expect(parseSourceFromFilename("antigravity-abc.md")).toBe("antigravity");
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
});
