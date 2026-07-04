const INDEX_SEARCH_DISABLE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);
const INDEX_VECTOR_ENABLE_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);

export function isIndexSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env["MEMORY_INDEX_SEARCH"]?.trim().toLowerCase();
  return value === undefined || value.length === 0 || !INDEX_SEARCH_DISABLE_VALUES.has(value);
}

export function isIndexVectorsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env["MEMORY_INDEX_VECTORS"]?.trim().toLowerCase();
  return value !== undefined && INDEX_VECTOR_ENABLE_VALUES.has(value);
}
