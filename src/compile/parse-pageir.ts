import { createHash } from "node:crypto";
import { basename } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { parseFrontmatter } from "../storage/frontmatter.js";
import { extractClaimsFromParagraph, type Claim } from "./extract-claims.js";

export type Block =
  | { type: "paragraph"; text: string }
  | { type: "checklist"; items: Array<{ checked: boolean; text: string }> }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; markdown: string }
  | { type: "table"; markdown: string }
  | { type: "blockquote"; markdown: string };

export interface PageIR {
  frontmatter: Record<string, unknown>;
  title: string;
  page_version: number;
  sections: Section[];
}

export interface Section {
  section_id: string;
  heading: string;
  level: 2 | 3;
  position_index: number;
  body_hash: string;
  body_markdown: string;
  body_blocks: Block[];
  claims: Claim[];
  has_structured_blocks: boolean;
}

interface HeadingMatch {
  lineIndex: number;
  level: 2 | 3;
  heading: string;
}

interface MarkdownNode {
  type?: string;
  depth?: number;
  value?: string;
  alt?: string;
  title?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: {
    start?: { line?: number };
  };
}

export function parsePageIR(content: string, relPath?: string): PageIR {
  const parsed = parseFrontmatter(content);
  const title = readTitle(parsed.frontmatter, parsed.body, relPath);
  const pageVersion = typeof parsed.frontmatter.version === "number" && Number.isFinite(parsed.frontmatter.version)
    ? Math.max(1, Math.floor(parsed.frontmatter.version))
    : 1;
  const lines = parsed.body.replace(/\r\n/g, "\n").split("\n");
  const headings = findSectionHeadings(lines);
  if (headings.length === 0) {
    const bodyMarkdown = trimBlankLines(parsed.body.replace(/\r\n/g, "\n"));
    const sectionId = makeSectionId(title, 0);
    const blocks = parseBlocks(bodyMarkdown);
    return {
      frontmatter: parsed.frontmatter,
      title,
      page_version: pageVersion,
      sections: [{
        section_id: sectionId,
        heading: title,
        level: 2,
        position_index: 0,
        body_hash: sha256(bodyMarkdown),
        body_markdown: bodyMarkdown,
        body_blocks: blocks,
        claims: blocks.flatMap((block) =>
          block.type === "paragraph"
            ? extractClaimsFromParagraph(sectionId, block.text, Math.max(0, bodyMarkdown.indexOf(block.text)))
            : []
        ),
        has_structured_blocks: blocks.some((block) => block.type !== "paragraph"),
      }],
    };
  }
  const sections = headings.map((heading, index) => {
    const next = headings[index + 1];
    const bodyLines = lines.slice(heading.lineIndex + 1, next?.lineIndex ?? lines.length);
    const bodyMarkdown = trimBlankLines(bodyLines.join("\n"));
    const sectionId = makeSectionId(title, index);
    const blocks = parseBlocks(bodyMarkdown);
    const claims = blocks.flatMap((block) =>
      block.type === "paragraph"
        ? extractClaimsFromParagraph(sectionId, block.text, Math.max(0, bodyMarkdown.indexOf(block.text)))
        : []
    );
    return {
      section_id: sectionId,
      heading: heading.heading,
      level: heading.level,
      position_index: index,
      body_hash: sha256(bodyMarkdown),
      body_markdown: bodyMarkdown,
      body_blocks: blocks,
      claims,
      has_structured_blocks: blocks.some((block) => block.type !== "paragraph"),
    };
  });

  return {
    frontmatter: parsed.frontmatter,
    title,
    page_version: pageVersion,
    sections,
  };
}

export function renderPageIRWithSectionBody(content: string, sectionId: string, replacementBlocks: Block[]): string | null {
  const parsed = parseFrontmatter(content);
  const title = readTitle(parsed.frontmatter, parsed.body);
  const lines = parsed.body.replace(/\r\n/g, "\n").split("\n");
  const headings = findSectionHeadings(lines);
  if (headings.length === 0) {
    const sectionIdForBody = makeSectionId(title, 0);
    if (sectionIdForBody !== sectionId) return null;
    return `${blocksToMarkdown(replacementBlocks).trim()}\n`;
  }
  const index = headings.findIndex((_, position) => makeSectionId(title, position) === sectionId);
  if (index < 0) return null;
  const heading = headings[index]!;
  const next = headings[index + 1];
  const before = lines.slice(0, heading.lineIndex + 1);
  const after = lines.slice(next?.lineIndex ?? lines.length);
  const replacement = blocksToMarkdown(replacementBlocks).split("\n");
  return trimBlankLines([...before, "", ...replacement, "", ...after].join("\n")) + "\n";
}

export function blocksToMarkdown(blocks: Block[]): string {
  return blocks.map((block) => {
    if (block.type === "paragraph") return block.text.trim();
    if (block.type === "checklist") {
      return block.items
        .map((item) => `- [${item.checked ? "x" : " "}] ${item.text.trim()}`)
        .join("\n");
    }
    if (block.type === "list") {
      return block.items
        .map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${item.trim()}`)
        .join("\n");
    }
    return block.markdown.trim();
  }).filter(Boolean).join("\n\n");
}

function findSectionHeadings(lines: string[]): HeadingMatch[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(lines.join("\n")) as MarkdownNode;
  return (tree.children ?? [])
    .filter((node) => node.type === "heading" && (node.depth === 2 || node.depth === 3))
    .map((node) => ({
      lineIndex: Math.max(0, (node.position?.start?.line ?? 1) - 1),
      level: node.depth as 2 | 3,
      heading: nodeText(node).trim(),
    }))
    .filter((heading) => heading.heading.length > 0);
}

function nodeText(node: MarkdownNode): string {
  if (typeof node.value === "string") return node.value;
  if (node.type === "image") return node.alt ?? node.title ?? "";
  return (node.children ?? []).map(nodeText).join("");
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  let buffer: string[] = [];
  let listBuffer: string[] = [];
  let inFence = false;
  let fence: string[] = [];

  function flushParagraph(): void {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: "paragraph", text });
    buffer = [];
  }

  function flushList(): void {
    if (listBuffer.length === 0) return;
    const checklistItems = listBuffer.map((line) => /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line));
    if (checklistItems.every((item) => item !== null)) {
      blocks.push({
        type: "checklist",
        items: checklistItems.map((item) => ({
          checked: item![1]!.toLowerCase() === "x",
          text: item![2]!.trim(),
        })),
      });
    } else {
      const ordered = listBuffer.every((line) => /^\s*\d+\.\s+/.test(line));
      blocks.push({
        type: "list",
        ordered,
        items: listBuffer.map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim()),
      });
    }
    listBuffer = [];
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        fence.push(line);
        blocks.push({ type: "code", markdown: fence.join("\n") });
        fence = [];
        inFence = false;
      } else {
        flushList();
        flushParagraph();
        inFence = true;
        fence = [line];
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    if (line.trim() === "") {
      flushList();
      flushParagraph();
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      listBuffer.push(line);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushList();
      flushParagraph();
      blocks.push({ type: "blockquote", markdown: line });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushList();
      flushParagraph();
      blocks.push({ type: "table", markdown: line });
      continue;
    }
    flushList();
    buffer.push(line.trim());
  }

  if (inFence && fence.length > 0) blocks.push({ type: "code", markdown: fence.join("\n") });
  flushList();
  flushParagraph();
  return blocks;
}

function readTitle(frontmatter: Record<string, unknown>, body: string, relPath?: string): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) return frontmatter.title.trim();
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim();
  if (heading) return heading;
  return relPath ? basename(relPath, ".md").replace(/-/g, " ") : "Untitled";
}

function makeSectionId(pageTitle: string, positionIndex: number): string {
  return `s_${sha1(`${pageTitle}\0${positionIndex}`).slice(0, 12)}`;
}

function trimBlankLines(value: string): string {
  return value.replace(/^\n+/, "").replace(/\n+$/, "");
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
