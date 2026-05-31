import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadWiki,
  runAllChecks,
  type LintCategory,
  type LintIssue,
} from "../../curation/checks.js";
import { readRuntimePrompt } from "../../prompts/runtime.js";
import {
  logPath,
  memoryRoot,
  schemaPath,
} from "../../storage/paths.js";

export interface LintOptions {
  checksOnly?: boolean;
  staleDays?: number;
  now?: Date;
  sourceRepoDir?: string;
}

export interface LintPromptResult {
  mode: "prompt";
  prompt: string;
}

export interface LintChecksResult {
  mode: "checks";
  report: string;
  issues: LintIssue[];
  counts: Record<string, number>;
  hasBlockingIssues: boolean;
}

export type LintResult = LintPromptResult | LintChecksResult;

const CATEGORIES: LintCategory[] = [
  "frontmatter",
  "broken-link",
  "broken-relation",
  "orphan",
  "stale",
  "draft",
];

export async function runLint(
  opts: LintOptions = {},
): Promise<LintResult> {
  if (opts.checksOnly) {
    const staleDays = readOptionalNonNegativeInteger(opts.staleDays, "staleDays");
    const pages = await loadWiki();
    const issues = runAllChecks(pages, {
      now: opts.now,
      staleDays,
    });
    const counts = countIssues(issues);
    const hasBlockingIssues = issues.some(
      (issue) =>
        issue.category === "frontmatter" ||
        issue.category === "broken-relation",
    );

    return {
      mode: "checks",
      report: formatChecksReport({
        pageCount: pages.length,
        issues,
        counts,
        hasBlockingIssues,
      }),
      issues,
      counts,
      hasBlockingIssues,
    };
  }

  const root = memoryRoot();
  const promptTemplate = await readRuntimePrompt({
    vaultRoot: root,
    name: "lint.md",
    sourceRepoDir: opts.sourceRepoDir,
    warn: (message) => console.error(message),
  }).then((prompt) => prompt.content).catch((error) => {
    throw new Error(`memory lint: ${(error as Error).message}`);
  });
  const schema = await readRequiredFile(schemaPath(), "schema.md");
  const log = await readOptionalFile(logPath());

  return {
    mode: "prompt",
    prompt: renderPrompt(promptTemplate, {
      schema_content: schema,
      recent_log_lines: tailLines(log, 50),
    }),
  };
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  if (!existsSync(path)) {
    throw new Error(`memory lint: missing ${label} at ${path}`);
  }
  return readFile(path, "utf-8");
}

async function readOptionalFile(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  return readFile(path, "utf-8");
}

function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : full;
  });
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

function readOptionalNonNegativeInteger(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`memory lint: ${name} must be a non-negative integer`);
  }
  return value;
}

function countIssues(issues: LintIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const category of CATEGORIES) counts[category] = 0;
  for (const issue of issues) {
    counts[issue.category] = (counts[issue.category] ?? 0) + 1;
  }
  return counts;
}

function formatChecksReport(opts: {
  pageCount: number;
  issues: LintIssue[];
  counts: Record<string, number>;
  hasBlockingIssues: boolean;
}): string {
  const lines: string[] = [
    "Memory lint checks-only",
    `Pages scanned: ${opts.pageCount}`,
    `Total issues: ${opts.issues.length}`,
    `Blocking issues: ${opts.hasBlockingIssues ? "yes" : "no"}`,
    "",
  ];

  for (const category of CATEGORIES) {
    lines.push(`${category}: ${opts.counts[category] ?? 0}`);
  }

  if (opts.issues.length === 0) {
    lines.push("", "No issues found.");
    return `${lines.join("\n")}\n`;
  }

  for (const category of CATEGORIES) {
    const grouped = opts.issues.filter((issue) => issue.category === category);
    if (grouped.length === 0) continue;
    lines.push("", `[${category}]`);
    for (const issue of grouped) {
      lines.push(`- ${issue.page}: ${issue.message}`);
      if (issue.suggestion) lines.push(`  suggestion: ${issue.suggestion}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
