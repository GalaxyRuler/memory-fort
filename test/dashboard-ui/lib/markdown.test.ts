import { describe, expect, it } from "vitest";
import { highlightSource, renderMarkdown } from "../../../src/dashboard-ui/lib/markdown.js";

describe("galactic markdown renderer", () => {
  it("renders frontmatter, headings, lists, quotes, code, inline marks, tables, wikilinks, and links", () => {
    const html = renderMarkdown(`---
title: Example
---

# Heading
## Subheading
Paragraph with **bold**, *italic*, \`code\`, [[wiki/projects/foo.md]], and [link](https://example.com).

- one
- two

> quote

| A | B |
| - | - |
| 1 | 2 |

\`\`\`ts
const x = 1;
\`\`\`
`);

    expect(html).toContain("markdown-frontmatter");
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<h2>Subheading</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('data-wikilink="wiki/projects/foo.md"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>quote</blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain("<pre><code");
  });

  it("highlights source without exposing raw HTML", () => {
    const html = highlightSource("---\ntitle: <x>\n---\n# Heading\n[[foo]]");

    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("yaml-key");
    expect(html).toContain("md-heading");
    expect(html).toContain("md-wikilink");
  });
});
