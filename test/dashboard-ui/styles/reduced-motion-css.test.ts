import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(resolve("src/dashboard-ui/index.css"), "utf8");
const dashboardSourceRoot = resolve("src/dashboard-ui");

function cssBlock(startIndex: number): string {
  const openBrace = css.indexOf("{", startIndex);
  expect(openBrace).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = openBrace; index < css.length; index++) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(openBrace + 1, index);
  }
  throw new Error("CSS block was not closed");
}

function noPreferenceMotionBlock(): string {
  const index = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  expect(index).toBeGreaterThanOrEqual(0);
  return cssBlock(index);
}

function dashboardSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...dashboardSourceFiles(path));
    } else if (/\.(css|ts|tsx)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

describe("dashboard CSS reduced motion", () => {
  test("only enables motion utility animations when motion is allowed", () => {
    const block = noPreferenceMotionBlock();
    for (const selector of [".glow-pulse", ".animate-spin-slow", ".animate-shimmer"]) {
      expect(block).toContain(selector);
    }
  });

  test("guards Tailwind pulse animations behind motion-safe variants", () => {
    const offenders = dashboardSourceFiles(dashboardSourceRoot)
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return source
          .split(/\r?\n/)
          .map((line, index) => ({ line, path, lineNumber: index + 1 }))
          .filter(({ line }) => /(?<!motion-safe:)animate-pulse/.test(line))
          .map(({ path, lineNumber }) => `${path}:${lineNumber}`);
      });

    expect(offenders).toEqual([]);
  });
});
