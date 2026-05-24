import { type PageDetail } from "../hooks/usePageDetail.js";
import { EntityIcon, type EntityType } from "./EntityIcon.js";
import { StatusPill, type StatusKind } from "./StatusPill.js";

const VALID_STATUS: StatusKind[] = ["active", "archived", "superseded", "draft"];
const VALID_ENTITY_TYPES: EntityType[] = [
  "projects",
  "decisions",
  "lessons",
  "references",
  "tools",
  "people",
  "crystals",
  "raw-session",
];

export function PageHeader({ page }: { page: PageDetail }) {
  const frontmatter = page.frontmatter;
  const status = frontmatter.status;
  const type = frontmatter.type;
  const validStatus = isStatusKind(status) ? status : "active";
  const validType = isEntityType(type) ? type : "projects";

  return (
    <header className="mb-6 border-b border-border-subtle pb-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <EntityIcon size="lg" type={validType} />
        <span className="text-xs uppercase tracking-wider text-text-muted">{type ?? "(no type)"}</span>
        <StatusPill kind={validStatus} />
      </div>
      <h1 className="mb-2 break-words text-2xl font-semibold tracking-tight md:text-3xl">
        {frontmatter.title ?? page.relPath}
      </h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-text-muted">
        <span>created {frontmatter.created ?? "?"}</span>
        <span>updated {frontmatter.updated ?? "?"}</span>
        {typeof frontmatter.confidence === "number" ? (
          <span>confidence {frontmatter.confidence.toFixed(2)}</span>
        ) : null}
        {frontmatter.source ? <span>via {frontmatter.source}</span> : null}
      </div>
      {Array.isArray(frontmatter.tags) && frontmatter.tags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {frontmatter.tags.map((tag) => (
            <span className="break-words rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </header>
  );
}

function isStatusKind(value: unknown): value is StatusKind {
  return typeof value === "string" && VALID_STATUS.includes(value as StatusKind);
}

function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && VALID_ENTITY_TYPES.includes(value as EntityType);
}
