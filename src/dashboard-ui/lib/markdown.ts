export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;

  if (lines[0] === "---") {
    const end = lines.findIndex((line, lineIndex) => lineIndex > 0 && line === "---");
    if (end > 0) {
      html.push(`<pre class="markdown-frontmatter"><code>${escapeHtml(lines.slice(0, end + 1).join("\n"))}</code></pre>`);
      index = end + 1;
    }
  }

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1;
      html.push(`<pre><code class="language-${escapeAttr(language)}">${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      html.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      html.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
      index += 1;
      continue;
    }

    if (/^\|.+\|$/.test(line) && /^\|\s*-/.test(lines[index + 1] ?? "")) {
      const rows: string[][] = [];
      rows.push(parseTableRow(line));
      index += 2;
      while (index < lines.length && /^\|.+\|$/.test(lines[index]!)) {
        rows.push(parseTableRow(lines[index]!));
        index += 1;
      }
      const [head = [], ...body] = rows;
      html.push(`<table><thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }

    if (/^- /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^- /.test(lines[index]!)) {
        items.push(`<li>${renderInline(lines[index]!.slice(2))}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !/^(#{1,3})\s+/.test(lines[index]!) &&
      !/^[-|>] /.test(lines[index]!) &&
      !lines[index]!.startsWith("```")
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return html.join("\n");
}

export function highlightSource(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/^([A-Za-z0-9_-]+):/gm, '<span class="yaml-key">$1</span>:')
    .replace(/^(#{1,6} .+)$/gm, '<span class="md-heading">$1</span>')
    .replace(/\[\[([^\]\n]+)\]\]/g, '<span class="md-wikilink">[[$1]]</span>');
}

function renderInline(input: string): string {
  return escapeHtml(input)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[\[([^\]\n]+)\]\]/g, (_match, target: string) => {
      const clean = String(target).trim();
      return `<button type="button" class="wikilink" data-wikilink="${escapeAttr(clean)}">[[${escapeHtml(clean)}]]</button>`;
    })
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function parseTableRow(line: string): string[] {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
