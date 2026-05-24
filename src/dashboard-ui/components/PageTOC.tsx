import { useMemo } from "react";

export function PageTOC({ body }: { body: string }) {
  const headings = useMemo(() => {
    return Array.from(body.matchAll(/^(#{2,3})\s+(.+)$/gm)).map((match) => {
      const text = (match[2] ?? "").trim();
      return {
        level: match[1]?.length ?? 2,
        text,
        slug: text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
      };
    });
  }, [body]);

  if (headings.length === 0) return null;

  return (
    <nav className="sticky top-4 text-sm">
      <h3 className="mb-2 text-xs uppercase tracking-wider text-text-muted">On this page</h3>
      <ul className="space-y-1">
        {headings.map((heading, index) => (
          <li className={heading.level === 3 ? "pl-3" : ""} key={`${heading.slug}-${index}`}>
            <a className="text-text-secondary hover:text-text-primary" href={`#${heading.slug}`}>
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
