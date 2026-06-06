import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../../storage/atomic-write.js";

/**
 * Read an existing JSON file (or {} if missing), apply a
 * deep-merge of the patch (with patch values winning on
 * conflict), and atomically write back. Preserves other top-
 * level keys not in the patch.
 */
export async function mergeJsonFile(
  path: string,
  patch: Record<string, unknown>,
): Promise<{ created: boolean; mergedKeys: string[] }> {
  let existing: Record<string, unknown> = {};
  let created = true;

  if (existsSync(path)) {
    created = false;
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const merged = deepMerge(existing, patch);
  await atomicWrite(path, JSON.stringify(merged, null, 2) + "\n");
  return { created, mergedKeys: Object.keys(patch) };
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = out[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue !== null &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      out[key] = deepMerge(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}
