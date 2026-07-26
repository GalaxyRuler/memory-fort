import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { MarkdownBody } from "../../../src/dashboard-ui/components/MarkdownBody.js";
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
    params: Record<string, string>;
    to: string;
  }) => (
    <a
      className={className}
      data-router-link="true"
      href={to.replace("$category", params.category).replace("$slug", params.slug)}
    >
      {children}
    </a>
  ),
}));

describe("MarkdownBody", () => {
  test("renders a preprocessed canonical wikilink as a router link", () => {
    const source = preprocessWikilinks("See [[Foo]].", [
      { key: "uses", target: "foo", resolvedPath: "wiki/projects/foo.md", resolvedTitle: "Foo" },
    ]);

    render(<MarkdownBody source={source} />);

    const link = screen.getByRole("link", { name: "Foo" });
    expect(link).toHaveAttribute("href", "/wiki/projects/foo");
    expect(link).toHaveAttribute("data-router-link", "true");
  });

  test("does not preserve an invalid wiki-like URL", () => {
    render(<MarkdownBody source="[Unsafe](wiki:javascript:alert)" />);

    const link = screen.getByText("Unsafe").closest("a");
    expect(link).toHaveAttribute("href", "");
    expect(link).not.toHaveAttribute("data-router-link");
  });

  test("does not preserve a canonical wiki URL on an image source", () => {
    render(<MarkdownBody source="![Preview](wiki:wiki/projects/foo.md)" />);

    const image = screen.getByRole("img", { name: "Preview" });
    expect(image.getAttribute("src") ?? "").toBe("");
  });

  test("preserves an ordinary external URL through the default transform", () => {
    render(<MarkdownBody source="[Example](https://example.com/docs)" />);

    const link = screen.getByRole("link", { name: "Example" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).not.toHaveAttribute("data-router-link");
  });
});
