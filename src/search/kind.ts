export type SearchKind = "wiki" | "raw" | "crystal";
export type SearchScope = "wiki" | "raw" | "crystals" | "all";

export interface SearchKindInput {
  readonly relPath: string;
  readonly kind?: unknown;
  readonly type?: unknown;
}

export function classifySearchKind(input: SearchKindInput): SearchKind {
  const relPath = input.relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    relPath.startsWith("crystals/")
    || relPath.startsWith("crystal/")
    || relPath.startsWith("wiki/crystals/")
  ) {
    return "crystal";
  }
  if (relPath.startsWith("raw/")) return "raw";
  if (relPath.startsWith("wiki/")) {
    return input.kind === "crystal" || input.type === "crystal" || input.type === "crystals"
      ? "crystal"
      : "wiki";
  }
  if (
    input.kind === "crystal"
    || input.type === "crystal"
    || input.type === "crystals"
  ) return "crystal";
  if (input.kind === "raw") return "raw";
  return "wiki";
}

export function isCrystalSearchItem(input: SearchKindInput): boolean {
  return classifySearchKind(input) === "crystal";
}

export function searchScopeAllows(scope: SearchScope, input: SearchKindInput): boolean {
  if (scope === "all") return true;
  const kind = classifySearchKind(input);
  if (scope === "crystals") return kind === "crystal";
  return kind === scope;
}

export function searchScopeSql(scope: SearchScope, filesAlias: string): string {
  switch (scope) {
    case "wiki":
      return `${filesAlias}.kind = 'wiki' AND ${filesAlias}.relPath NOT GLOB 'wiki/crystals/*'`;
    case "raw":
      return `${filesAlias}.kind = 'raw'`;
    case "crystals":
      return `(${filesAlias}.kind = 'crystal' OR ${filesAlias}.relPath GLOB 'wiki/crystals/*')`;
    case "all":
      return "1 = 1";
  }
}
