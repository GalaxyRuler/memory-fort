/**
 * SQL counterpart to storage/archive-paths.ts. `lower()` makes the policy
 * portable across Windows and case-sensitive filesystems, and the glob rules
 * exclude archive or dot/system components at every depth.
 */
export function activeArchiveSystemPathSql(filesAlias: string): string[] {
  const path = `lower(${filesAlias}.relPath)`;
  return [
    `${path} NOT GLOB 'archive'`,
    `${path} NOT GLOB 'archive/*'`,
    `${path} NOT GLOB '*/archive'`,
    `${path} NOT GLOB '*/archive/*'`,
    `${path} NOT GLOB '.*'`,
    `${path} NOT GLOB '*/.*'`,
  ];
}
