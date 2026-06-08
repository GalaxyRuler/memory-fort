import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
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

const CONFIGURED_CATEGORY_ORDER = [
  "decisions",
  "projects",
  "issues",
  "lessons",
  "references",
  "tools",
  "people",
  "threads",
  "procedures",
  "crystals",
];

describe("wiki browse components", () => {
  test("CategorySidebar renders categories with counts", () => {
    render(<CategorySidebar index={INDEX} onSelect={() => {}} selectedCategory={null} />);

    expect(screen.getByRole("button", { name: /All/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /projects/i })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /decisions/i })).toHaveTextContent("1");
  });

  test("CategorySidebar renders zero-count configured categories before extra data categories", () => {
    const index: WikiIndex = {
      byCategory: {
        projects: INDEX.byCategory.projects,
        snippets: [
          {
            category: "snippets",
            slug: "query-helper",
            relPath: "wiki/snippets/query-helper.md",
            title: "Query helper",
            summary: "Extra category page",
            updated: "2026-05-25",
          },
        ],
      },
      total: 2,
    };

    render(<CategorySidebar index={index} onSelect={() => {}} selectedCategory={null} />);

    for (const category of CONFIGURED_CATEGORY_ORDER) {
      expect(screen.getByRole("button", { name: new RegExp(category, "i") })).toHaveTextContent(
        category === "projects" ? "1" : "0",
      );
    }
    expect(screen.getByRole("button", { name: /snippets/i })).toHaveTextContent("1");

    const categoryLabels = screen
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent?.replace(/\d+$/, ""));
    expect(categoryLabels).toEqual([...CONFIGURED_CATEGORY_ORDER, "snippets"]);
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

  test("WikiBrowsePage header count matches visible category counts instead of stale total", () => {
    wikiHook.useWikiIndex.mockReturnValue({
      data: {
        byCategory: {
          projects: INDEX.byCategory.projects,
          decisions: INDEX.byCategory.decisions,
          lessons: [],
        },
        total: 99,
      },
      isLoading: false,
    });

    render(<WikiBrowsePage />);

    expect(screen.getByText("2 curated pages")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All/ })).toHaveTextContent("2");
  });
});
