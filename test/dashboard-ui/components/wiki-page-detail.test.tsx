import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { PageHeader } from "../../../src/dashboard-ui/components/PageHeader.js";
import { PageRelations } from "../../../src/dashboard-ui/components/PageRelations.js";
import { PageTOC } from "../../../src/dashboard-ui/components/PageTOC.js";
import type { PageDetail, PageRelation } from "../../../src/dashboard-ui/hooks/usePageDetail.js";
import { preprocessWikilinks } from "../../../src/dashboard-ui/lib/wikilinks.js";

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

function makePage(): PageDetail {
  return {
    relPath: "wiki/decisions/foo.md",
    frontmatter: {
      type: "decisions",
      title: "Foo Decision",
      created: "2026-05-20",
      updated: "2026-05-24",
      status: "active",
      confidence: 0.9,
      tags: ["voyage", "retrieval"],
    },
    body: "## Context\nBody",
    relations: [],
    inbound: [],
  };
}

describe("wiki page detail components", () => {
  test("PageHeader renders title, type, status, and tags", () => {
    render(<PageHeader page={makePage()} />);

    expect(screen.getByRole("heading", { name: "Foo Decision" })).toBeInTheDocument();
    expect(screen.getByText("decisions")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("voyage")).toBeInTheDocument();
  });

  test("PageRelations groups by edge type", () => {
    const relations: PageRelation[] = [
      { key: "uses", target: "voyageai", resolvedPath: "wiki/tools/voyageai.md", resolvedTitle: "voyageai" },
      {
        key: "depends_on",
        target: "memory-system",
        resolvedPath: "wiki/projects/memory-system.md",
        resolvedTitle: "memory-system",
      },
    ];

    render(<PageRelations inbound={[]} relations={relations} />);

    expect(screen.getByText("uses")).toBeInTheDocument();
    expect(screen.getByText("depends_on")).toBeInTheDocument();
  });

  test("PageRelations marks unresolved targets", () => {
    render(
      <PageRelations
        inbound={[]}
        relations={[{ key: "uses", target: "missing", resolvedPath: null, resolvedTitle: null }]}
      />,
    );

    expect(screen.getByText("[unresolved]")).toBeInTheDocument();
  });

  test("PageTOC extracts second and third level headings", () => {
    render(<PageTOC body={"# Title\n\n## Context\n\n### Detail\n\n## Decision"} />);

    expect(screen.getByRole("link", { name: "Context" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Detail" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Decision" })).toBeInTheDocument();
  });

  test("preprocessWikilinks converts resolved wikilinks to markdown links", () => {
    const body = preprocessWikilinks("see [[foo]]", [
      { key: "uses", target: "foo", resolvedPath: "wiki/projects/foo.md", resolvedTitle: "Foo" },
    ]);

    expect(body).toContain("[foo](wiki:wiki/projects/foo.md)");
  });
});
