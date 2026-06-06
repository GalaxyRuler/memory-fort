import { cn } from "../lib/cn.js";

export type EntityType =
  | "projects"
  | "issues"
  | "decisions"
  | "lessons"
  | "references"
  | "tools"
  | "people"
  | "crystals"
  | "raw-session";

export interface EntityIconProps {
  type: EntityType;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_MAP = { sm: "h-1.5 w-1.5", md: "h-2 w-2", lg: "h-3 w-3" };
const COLOR_MAP: Record<EntityType, string> = {
  projects: "bg-entity-projects",
  issues: "bg-entity-decisions",
  decisions: "bg-entity-decisions",
  lessons: "bg-entity-lessons",
  references: "bg-entity-references",
  tools: "bg-entity-tools",
  people: "bg-entity-people",
  crystals: "bg-entity-crystals",
  "raw-session": "bg-entity-raw-session",
};

export function EntityIcon({ type, size = "md", className }: EntityIconProps) {
  return (
    <span
      className={cn("inline-block flex-shrink-0 rounded-full", SIZE_MAP[size], COLOR_MAP[type], className)}
      aria-label={`${type} entity`}
    />
  );
}
