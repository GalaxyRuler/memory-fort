import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { CategorySidebar } from "../../../src/dashboard-ui/components/CategorySidebar.js";
import { WikiCard } from "../../../src/dashboard-ui/components/WikiCard.js";
import type { WikiIndex, WikiIndexEntry } from "../../../src/dashboard-ui/hooks/useWikiIndex.js";

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
    const href = params ? to.replace("$category", params.category).replace("$slug", params.slug) : to;
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  },
}));

const INDEX: WikiIndex = {
  byCategory: {
    projects: [
      {
        category: "projects",
        slug: "memory-system",
        relPath: "wiki/projects/memory-system.md",
        title: "memory-system",
        summary: "Project page",
        updated: "2026-05-24",
      },
    ],
    decisions: [
      {
        category: "decisions",
        slug: "voyage",
        relPath: "wiki/decisions/voyage.md",
        title: "Voyage",
        summary: "Decision page",
        updated: "2026-05-23",
      },
    ],
  },
  total: 2,
};

describe("wiki browse components", () => {
  test("CategorySidebar renders categories with counts", () => {
    render(<CategorySidebar index={INDEX} onSelect={() => {}} selectedCategory={null} />);

    expect(screen.getByRole("button", { name: /All/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /projects/i })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /decisions/i })).toHaveTextContent("1");
  });

  test("CategorySidebar fires onSelect with null for All", () => {
    const onSelect = vi.fn();
    render(<CategorySidebar index={INDEX} onSelect={onSelect} selectedCategory="projects" />);

    fireEvent.click(screen.getByRole("button", { name: /All/ }));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  test("WikiCard links to the category and slug route", () => {
    const entry: WikiIndexEntry = INDEX.byCategory.projects[0]!;

    render(<WikiCard entry={entry} />);

    const link = screen.getByRole("link", { name: /memory-system/ });
    expect(link).toHaveAttribute("href", "/wiki/projects/memory-system");
    expect(within(link).getByText("Project page")).toBeInTheDocument();
  });
});
