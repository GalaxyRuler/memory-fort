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
    search,
    to,
  }: {
    children: ReactNode;
    className?: string;
    params?: Record<string, string>;
    search?: Record<string, number | string | undefined>;
    to: string;
  }) => {
    let href = to;
    for (const [key, value] of Object.entries(params ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      href = href.replace(`$${key}`, encodeURIComponent(value));
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(search ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (value !== undefined) query.set(key, String(value));
    }
    const queryString = query.toString();
    if (queryString) href += `?${queryString}`;
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
    archived: false,
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

  test("PageHeader shows archived when the page path is archived", () => {
    const archived = makePage();
    archived.archived = true;

    render(<PageHeader page={archived} />);

    expect(screen.getByText("archived")).toBeInTheDocument();
    expect(screen.queryByText("active")).not.toBeInTheDocument();
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

    expect(screen.getByRole("region", { name: "Page relations" })).toBeInTheDocument();
    expect(screen.getByText("uses")).toBeInTheDocument();
    expect(screen.getByText("depends_on")).toBeInTheDocument();
  });

  test("PageRelations links resolved outward and inbound pages without archive opt-in", () => {
    render(
      <PageRelations
        inbound={[
          {
            fromPath: "wiki/decisions/source.md",
            fromTitle: "Source Decision",
            via: "uses",
          },
        ]}
        relations={[
          {
            key: "uses",
            target: "voyageai",
            resolvedPath: "wiki/tools/voyageai.md",
            resolvedTitle: "Voyage AI",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Voyage AI" })).toHaveAttribute(
      "href",
      "/wiki/tools/voyageai",
    );
    expect(screen.getByRole("link", { name: "Source Decision" })).toHaveAttribute(
      "href",
      "/wiki/decisions/source",
    );
  });

  test("PageRelations preserves archive opt-in on resolved outward and inbound links", () => {
    render(
      <PageRelations
        includeArchived
        inbound={[
          {
            fromPath: "wiki/decisions/source.md",
            fromTitle: "Source Decision",
            via: "uses",
          },
        ]}
        relations={[
          {
            key: "uses",
            target: "voyageai",
            resolvedPath: "wiki/tools/voyageai.md",
            resolvedTitle: "Voyage AI",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Voyage AI" })).toHaveAttribute(
      "href",
      "/wiki/tools/voyageai?includeArchived=1",
    );
    expect(screen.getByRole("link", { name: "Source Decision" })).toHaveAttribute(
      "href",
      "/wiki/decisions/source?includeArchived=1",
    );
  });

  test("PageRelations exposes the empty state in a named region", () => {
    render(<PageRelations inbound={[]} relations={[]} />);

    const region = screen.getByRole("region", { name: "Page relations" });
    expect(region).toBeInTheDocument();
    expect(screen.getByText("No relations yet")).toBeInTheDocument();
  });

  test("PageRelations marks unresolved targets", () => {
    render(
      <PageRelations
        inbound={[]}
        relations={[{ key: "uses", target: "missing", resolvedPath: null, resolvedTitle: null }]}
      />,
    );

    expect(screen.getByText("[unresolved]")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /missing/ })).not.toBeInTheDocument();
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
