import { type PageRelation } from "../hooks/usePageDetail.js";

const WIKI_PATH_PREFIX = "wiki/";
const MARKDOWN_EXTENSION = ".md";
const SAFE_WIKI_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

interface Fence {
  marker: "`" | "~";
  length: number;
}

function setStableResolution(map: Map<string, string>, key: string, resolvedPath: string): void {
  const existing = map.get(key);
  if (!existing || resolvedPath < existing) {
    map.set(key, resolvedPath);
  }
}

function replaceProseWikilinks(source: string, resolutionMap: Map<string, string>): string {
  return source.replace(WIKILINK_RE, (_match, target: string) => {
    const cleanTarget = target.trim();
    const resolved = resolutionMap.get(cleanTarget.toLowerCase());
    if (resolved) {
      return `[${cleanTarget}](wiki:${resolved})`;
    }
    return `[${cleanTarget}]`;
  });
}

function findClosingBacktickRun(source: string, start: number, delimiterLength: number): number {
  let cursor = start;
  while (cursor < source.length) {
    const runStart = source.indexOf("`", cursor);
    if (runStart === -1) return -1;

    let runEnd = runStart + 1;
    while (source[runEnd] === "`") runEnd += 1;
    if (runEnd - runStart === delimiterLength) return runStart;
    cursor = runEnd;
  }
  return -1;
}

function replaceOutsideInlineCode(source: string, resolutionMap: Map<string, string>): string {
  let output = "";
  let proseStart = 0;
  let cursor = 0;

  while (cursor < source.length) {
    if (source[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    const openerStart = cursor;
    while (source[cursor] === "`") cursor += 1;
    const delimiterLength = cursor - openerStart;
    const closerStart = findClosingBacktickRun(source, cursor, delimiterLength);
    if (closerStart === -1) continue;

    output += replaceProseWikilinks(source.slice(proseStart, openerStart), resolutionMap);
    const codeEnd = closerStart + delimiterLength;
    output += source.slice(openerStart, codeEnd);
    cursor = codeEnd;
    proseStart = codeEnd;
  }

  return output + replaceProseWikilinks(source.slice(proseStart), resolutionMap);
}

function parseOpeningFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;

  const delimiter = match[1]!;
  const marker = delimiter[0] as "`" | "~";
  if (marker === "`" && match[2]!.includes("`")) return null;
  return { marker, length: delimiter.length };
}

function isClosingFence(line: string, fence: Fence): boolean {
  let cursor = 0;
  while (cursor < 3 && line[cursor] === " ") cursor += 1;

  const markerStart = cursor;
  while (line[cursor] === fence.marker) cursor += 1;
  if (cursor - markerStart < fence.length) return false;

  return /^[ \t]*$/.test(line.slice(cursor));
}

function lineBounds(source: string, start: number): {
  contentEnd: number;
  nextLineStart: number;
} {
  const newline = source.indexOf("\n", start);
  if (newline === -1) {
    const contentEnd = source.endsWith("\r") ? source.length - 1 : source.length;
    return { contentEnd, nextLineStart: source.length };
  }

  const contentEnd = newline > start && source[newline - 1] === "\r"
    ? newline - 1
    : newline;
  return { contentEnd, nextLineStart: newline + 1 };
}

function findFenceBlockEnd(source: string, start: number, fence: Fence): number {
  let lineStart = start;
  while (lineStart < source.length) {
    const { contentEnd, nextLineStart } = lineBounds(source, lineStart);
    if (isClosingFence(source.slice(lineStart, contentEnd), fence)) {
      return nextLineStart;
    }
    lineStart = nextLineStart;
  }
  return source.length;
}

function replaceOutsideCode(source: string, resolutionMap: Map<string, string>): string {
  let output = "";
  let proseStart = 0;
  let lineStart = 0;

  while (lineStart < source.length) {
    const { contentEnd, nextLineStart } = lineBounds(source, lineStart);
    const fence = parseOpeningFence(source.slice(lineStart, contentEnd));
    if (!fence) {
      lineStart = nextLineStart;
      continue;
    }

    output += replaceOutsideInlineCode(source.slice(proseStart, lineStart), resolutionMap);
    const fenceEnd = findFenceBlockEnd(source, nextLineStart, fence);
    output += source.slice(lineStart, fenceEnd);
    proseStart = fenceEnd;
    lineStart = fenceEnd;
  }

  return output + replaceOutsideInlineCode(source.slice(proseStart), resolutionMap);
}

export function preprocessWikilinks(body: string, relations: PageRelation[]): string {
  const explicitTargets = new Map<string, string>();
  const filenameAliases = new Map<string, string>();
  for (const relation of relations) {
    if (!relation.resolvedPath) continue;
    setStableResolution(explicitTargets, relation.target.toLowerCase(), relation.resolvedPath);
    const filename = relation.resolvedPath.split("/").pop()?.replace(/\.md$/, "");
    if (filename) {
      setStableResolution(filenameAliases, filename.toLowerCase(), relation.resolvedPath);
    }
  }

  const resolutionMap = new Map(filenameAliases);
  for (const [target, resolvedPath] of explicitTargets) {
    resolutionMap.set(target, resolvedPath);
  }

  return replaceOutsideCode(body, resolutionMap);
}

export function wikiPathToRouterParams(resolvedPath: string): { category: string; slug: string } | null {
  if (
    !resolvedPath.startsWith(WIKI_PATH_PREFIX)
    || !resolvedPath.endsWith(MARKDOWN_EXTENSION)
    || resolvedPath.includes("\\")
    || resolvedPath.includes("?")
    || resolvedPath.includes("#")
  ) {
    return null;
  }

  const pagePath = resolvedPath.slice(WIKI_PATH_PREFIX.length, -MARKDOWN_EXTENSION.length);
  const parts = pagePath.split("/");
  if (
    parts.length < 2
    || parts.some((part) => (
      part.length === 0
      || part === "."
      || part.includes("..")
      || !SAFE_WIKI_SEGMENT_RE.test(part)
    ))
  ) {
    return null;
  }

  return { category: parts[0]!, slug: parts.slice(1).join("/") };
}
