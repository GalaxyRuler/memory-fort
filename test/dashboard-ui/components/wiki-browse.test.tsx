import { fireEvent, render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CategorySidebar } from "../../../src/dashboard-ui/components/CategorySidebar.js";
import { WikiBrowsePage } from "../../../src/dashboard-ui/components/WikiBrowsePage.js";
import { WikiCard } from "../../../src/dashboard-ui/components/WikiCard.js";
import type { WikiIndex, WikiIndexEntry } from "../../../src/dashboard-ui/hooks/useWikiIndex.js";

const routerState = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

const wikiHook = vi.hoisted(() => ({
  useWikiIndex: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    params,
    to,
    ...props
  }: {
    children: ReactNode;
    className?: string;
    params?: Record<string, string>;
    to: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const href = params ? to.replace("$category", params.category).replace("$slug", params.slug) : to;
    return (
      <a className={className} href={href} {...props}>
        {children}
      </a>
    );
  },
  useNavigate: () => routerState.navigate,
  useSearch: () => routerState.search,
}));

vi.mock("../../../src/dashboard-ui/hooks/useWikiIndex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useWikiIndex.js")>();
  return {
    ...actual,
    useWikiIndex: wikiHook.useWikiIndex,
  };
});

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
  beforeEach(() => {
    routerState.search = {};
    routerState.navigate.mockReset();
    wikiHook.useWikiIndex.mockReset();
  });

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

  test("WikiBrowsePage groups all pages by known categories and skips empty groups", () => {
    wikiHook.useWikiIndex.mockReturnValue({
      data: {
        byCategory: {
          projects: INDEX.byCategory.projects,
          decisions: INDEX.byCategory.decisions,
          lessons: [],
        },
        total: 2,
      },
      isLoading: false,
    });

    render(<WikiBrowsePage />);

    expect(screen.getByRole("heading", { name: "Projects", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Decisions", level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Lessons", level: 2 })).not.toBeInTheDocument();
    expect(screen.getByText("memory-system")).toBeInTheDocument();
    expect(screen.getByText("Voyage")).toBeInTheDocument();
  });

  test("WikiBrowsePage exposes wiki cards as list items with nested links", () => {
    routerState.search = { category: "projects" };
    wikiHook.useWikiIndex.mockReturnValue({
      data: INDEX,
      isLoading: false,
    });

    render(<WikiBrowsePage />);

    const list = screen.getByRole("list", { name: "Wiki pages" });
    const item = within(list).getByRole("listitem");

    expect(within(item).getByRole("link", { name: /memory-system/i })).toHaveAttribute(
      "href",
      "/wiki/projects/memory-system",
    );
    expect(within(item).getByRole("link", { name: /memory-system/i })).toHaveAttribute("tabindex", "0");
  });

  test("WikiBrowsePage j/k navigation focuses native wiki links", () => {
    routerState.search = { category: "projects" };
    wikiHook.useWikiIndex.mockReturnValue({
      data: {
        byCategory: {
          projects: [
            INDEX.byCategory.projects[0]!,
            {
              category: "projects",
              slug: "memory-system-next",
              relPath: "wiki/projects/memory-system-next.md",
              title: "memory-system-next",
              summary: "Next project page",
              updated: "2026-05-25",
            },
          ],
        },
        total: 2,
      },
      isLoading: false,
    });

    render(<WikiBrowsePage />);

    const list = screen.getByRole("list", { name: "Wiki pages" });
    list.focus();
    fireEvent.keyDown(list, { key: "j" });

    const nextLink = screen.getByRole("link", { name: /memory-system-next/i });
    expect(nextLink).toHaveFocus();
    expect(nextLink).toHaveAttribute("data-focused", "true");
  });
});
