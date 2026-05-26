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
const KNOWN_COGNITIVE_TYPES = ["core", "semantic", "episodic", "procedural"] as const;

const KNOWN_RELATIONS = [
  "uses",
  "depends_on",
  "supersedes",
  "contradicts",
  "caused_by",
  "fixed_by",
  "derived_from",
  "mentioned_in",
  "linked",
] as const;

const YAML_DUMP_OPTIONS: yaml.DumpOptions = {
  schema: yaml.JSON_SCHEMA,
  indent: 2,
  lineWidth: -1,         // never wrap
  noRefs: true,
  quotingType: '"',
};

const YAML_ENGINE = {
  parse: (input: string): object =>
    (yaml.load(input, { schema: yaml.JSON_SCHEMA }) ?? {}) as object,
  stringify: (data: object): string => yaml.dump(data, YAML_DUMP_OPTIONS),
};

export function parseFrontmatter(content: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const parsed = matter(content, { engines: { yaml: YAML_ENGINE } });
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
  const fmYaml = quoteDateFields(yaml.dump(fm, YAML_DUMP_OPTIONS));
  // Ensure body ends in single newline; trim leading blank
  const cleanBody = body.replace(/^\n+/, "").replace(/\n*$/, "\n");
  return `---\n${fmYaml}---\n\n${cleanBody}`;
}

function quoteDateFields(text: string): string {
  return text.replace(
    /^(created|updated): (\d{4}-\d{2}-\d{2})$/gm,
    '$1: "$2"',
  );
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
  if (
    f["cognitive_type"] !== undefined &&
    !KNOWN_COGNITIVE_TYPES.includes(f["cognitive_type"] as never)
  ) {
    errors.push(`cognitive_type must be one of: ${KNOWN_COGNITIVE_TYPES.join(", ")}`);
  }
  if (f["confidence"] !== undefined) {
    const c = f["confidence"];
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      errors.push("confidence must be a number between 0 and 1");
    }
  }
  if (f["tags"] !== undefined) {
    if (!Array.isArray(f["tags"])) {
      errors.push("tags must be an array of strings");
    } else {
      const allStrings = (f["tags"] as unknown[]).every(
        (t) => typeof t === "string",
      );
      if (!allStrings) {
        errors.push("tags must contain only strings");
      }
    }
  }
  if (f["relations"] !== undefined) {
    const rel = f["relations"];
    if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
      errors.push("relations must be an object");
    } else {
      for (const [k, v] of Object.entries(rel as Record<string, unknown>)) {
        if (!KNOWN_RELATIONS.includes(k as never)) {
          errors.push(
            `relations.${k} is not a known edge type (expected one of: ${KNOWN_RELATIONS.join(", ")})`,
          );
        }
        if (!Array.isArray(v)) {
          errors.push(`relations.${k} must be an array of page paths`);
        } else if (!(v as unknown[]).every((s) => typeof s === "string")) {
          errors.push(`relations.${k} must contain only string page paths`);
        }
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, fm: fm as Frontmatter };
}
