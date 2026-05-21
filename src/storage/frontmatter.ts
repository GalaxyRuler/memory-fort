import matter from "gray-matter";
import yaml from "js-yaml";
import type { PageType, ToolName } from "./paths.js";

export type EntityType = PageType | "crystal" | "raw-session";

export interface Frontmatter {
  type: EntityType;
  title: string;
  created: string;   // ISO 8601 date (YYYY-MM-DD)
  updated: string;
  status?: "active" | "archived" | "superseded";
  confidence?: number;
  source?: ToolName | "crystal";
  session?: string;
  relations?: Record<string, string[]>;
  tags?: string[];
  [key: string]: unknown;
}

const KNOWN_TYPES: EntityType[] = [
  "projects",
  "people",
  "decisions",
  "lessons",
  "references",
  "tools",
  "crystal",
  "raw-session",
];

const KNOWN_STATUS = ["active", "archived", "superseded"] as const;

export function parseFrontmatter(content: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const parsed = matter(content);
  return {
    frontmatter: parsed.data as Frontmatter,
    body: parsed.content,
  };
}

export function serializeFrontmatter(
  fm: Frontmatter,
  body: string,
): string {
  // js-yaml dump with consistent style: no flow, 2-space indent
  const fmYaml = yaml.dump(fm, {
    indent: 2,
    lineWidth: -1,         // never wrap
    noRefs: true,
    quotingType: '"',
  });
  // Ensure body ends in single newline; trim leading blank
  const cleanBody = body.replace(/^\n+/, "").replace(/\n*$/, "\n");
  return `---\n${fmYaml}---\n\n${cleanBody}`;
}

export function validateFrontmatter(
  fm: unknown,
):
  | { valid: true; fm: Frontmatter }
  | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof fm !== "object" || fm === null) {
    return { valid: false, errors: ["frontmatter must be an object"] };
  }
  const f = fm as Record<string, unknown>;
  if (typeof f["type"] !== "string" || !KNOWN_TYPES.includes(f["type"] as EntityType)) {
    errors.push(`type must be one of: ${KNOWN_TYPES.join(", ")}`);
  }
  if (typeof f["title"] !== "string" || f["title"].trim().length === 0) {
    errors.push("title required and non-empty");
  }
  for (const field of ["created", "updated"] as const) {
    const v = f[field];
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      errors.push(`${field} required as ISO 8601 date (YYYY-MM-DD)`);
    }
  }
  if (f["status"] !== undefined && !KNOWN_STATUS.includes(f["status"] as never)) {
    errors.push(`status must be one of: ${KNOWN_STATUS.join(", ")}`);
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, fm: fm as Frontmatter };
}
