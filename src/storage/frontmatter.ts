import matter from "gray-matter";
import yaml from "js-yaml";
import type { PageType } from "./paths.js";
import {
  RELATION_TYPES,
  readRelationEntry,
  type SerializedRelationMap,
} from "../retrieval/relations.js";

export type EntityType = PageType | "crystal" | "raw-session";

export type ValidationState =
  | "unvalidated"
  | "auto"
  | "user"
  | "challenged"
  | "revoked";

export type LifecycleStage =
  | "observed"
  | "linked"
  | "proposed"
  | "consolidated"
  | "canonical"
  | "stale"
  | "disputed"
  | "dormant"
  | "archived";

export interface ConfidenceVector {
  extraction?: number;
  source?: number;
  validation?: ValidationState;
  freshness?: string;
  conflict?: string | null;
}

export interface TimeRange {
  start: string;
  end?: string | null;
}

export interface Frontmatter {
  type: EntityType;
  title: string;
  created: string;   // ISO 8601 date (YYYY-MM-DD)
  updated: string;
  status?: "active" | "archived" | "superseded";
  confidence?: number | ConfidenceVector;
  cognitive_type?: "core" | "semantic" | "episodic" | "procedural" | "prospective";
  lifecycle?: LifecycleStage;
  due?: string | null;
  triggers?: string[];
  expires?: string | null;
  time_range?: TimeRange;
  source?: string;
  session?: string;
  relations?: SerializedRelationMap;
  tags?: string[];
  [key: string]: unknown;
}

const KNOWN_TYPES: EntityType[] = [
  "projects",
  "issues",
  "people",
  "decisions",
  "lessons",
  "prospective",
  "procedures",
  "threads",
  "references",
  "tools",
  "crystal",
  "raw-session",
];

const KNOWN_STATUS = ["active", "archived", "superseded"] as const;
export const KNOWN_VALIDATION_STATES = [
  "unvalidated",
  "auto",
  "user",
  "challenged",
  "revoked",
] as const satisfies readonly ValidationState[];
export const KNOWN_LIFECYCLE_STAGES = [
  "observed",
  "linked",
  "proposed",
  "consolidated",
  "canonical",
  "stale",
  "disputed",
  "dormant",
  "archived",
] as const satisfies readonly LifecycleStage[];
const KNOWN_COGNITIVE_TYPES = ["core", "semantic", "episodic", "procedural", "prospective"] as const;

const KNOWN_RELATIONS = RELATION_TYPES;

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
    frontmatter: sanitizeFrontmatter(parsed.data as Record<string, unknown>),
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
    /^(created|updated|last_accessed): (\d{4}-\d{2}-\d{2})$/gm,
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
    f["lifecycle"] !== undefined &&
    !KNOWN_LIFECYCLE_STAGES.includes(f["lifecycle"] as never)
  ) {
    errors.push(`lifecycle must be one of: ${KNOWN_LIFECYCLE_STAGES.join(", ")}`);
  }
  if (
    f["cognitive_type"] !== undefined &&
    !KNOWN_COGNITIVE_TYPES.includes(f["cognitive_type"] as never)
  ) {
    errors.push(`cognitive_type must be one of: ${KNOWN_COGNITIVE_TYPES.join(", ")}`);
  }
  validateOptionalDateString(f, "due", errors);
  validateOptionalDateString(f, "expires", errors);
  validateTimeRange(f["time_range"], errors);
  if (f["triggers"] !== undefined) {
    if (!Array.isArray(f["triggers"])) {
      errors.push("triggers must be an array of strings");
    } else {
      const allStrings = (f["triggers"] as unknown[]).every(
        (t) => typeof t === "string",
      );
      if (!allStrings) {
        errors.push("triggers must contain only strings");
      }
    }
  }
  if (f["confidence"] !== undefined) {
    const c = f["confidence"];
    if (typeof c === "number") {
      if (!Number.isFinite(c) || c < 0 || c > 1) {
        errors.push("confidence must be a number between 0 and 1");
      }
    } else if (typeof c === "object" && c !== null && !Array.isArray(c)) {
      validateConfidenceVector(c as Record<string, unknown>, errors);
    } else {
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
        } else if (!(v as unknown[]).every((entry) => readRelationEntry(entry) !== null)) {
          errors.push(`relations.${k} must contain only string page paths or relation-edge objects with target`);
        }
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, fm: fm as Frontmatter };
}

function sanitizeFrontmatter(data: Record<string, unknown>): Frontmatter {
  if (!Object.hasOwn(data, "time_range")) {
    return data as Frontmatter;
  }

  const timeRange = normalizeTimeRange(data["time_range"]);
  if (timeRange) {
    return { ...data, time_range: timeRange } as Frontmatter;
  }

  const { time_range: _dropped, ...rest } = data;
  console.warn("Dropped malformed time_range frontmatter field");
  return rest as Frontmatter;
}

function validateOptionalDateString(
  frontmatter: Record<string, unknown>,
  field: "due" | "expires",
  errors: string[],
): void {
  const value = frontmatter[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${field} must be a parseable date string or null`);
  }
}

function validateTimeRange(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!normalizeTimeRange(value)) {
    errors.push("time_range must be an object with a parseable start date and optional parseable end date or null");
  }
}

function normalizeTimeRange(value: unknown): TimeRange | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const start = record["start"];
  if (typeof start !== "string" || Number.isNaN(Date.parse(start))) {
    return null;
  }

  const end = record["end"];
  if (end === undefined) return { start };
  if (end === null) return { start, end: null };
  if (typeof end === "string" && !Number.isNaN(Date.parse(end))) {
    return { start, end };
  }
  return null;
}

function validateConfidenceVector(
  confidence: Record<string, unknown>,
  errors: string[],
): void {
  for (const field of ["extraction", "source"] as const) {
    const value = confidence[field];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    ) {
      errors.push(`confidence.${field} must be a number between 0 and 1`);
    }
  }

  const validation = confidence["validation"];
  if (
    validation !== undefined &&
    !KNOWN_VALIDATION_STATES.includes(validation as never)
  ) {
    errors.push(
      `confidence.validation must be one of: ${KNOWN_VALIDATION_STATES.join(", ")}`,
    );
  }

  const freshness = confidence["freshness"];
  if (
    freshness !== undefined &&
    (typeof freshness !== "string" || Number.isNaN(Date.parse(freshness)))
  ) {
    errors.push("confidence.freshness must be a parseable ISO date");
  }

  const conflict = confidence["conflict"];
  if (
    conflict !== undefined &&
    conflict !== null &&
    typeof conflict !== "string"
  ) {
    errors.push("confidence.conflict must be a string or null");
  }
}
