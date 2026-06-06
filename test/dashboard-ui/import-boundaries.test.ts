import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("dashboard UI import boundaries", () => {
  it("does not import server-side modules at runtime", async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const uiRoot = resolve(testDir, "../../src/dashboard-ui");
    const files = await listSourceFiles(uiRoot);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const imports = source.match(/^\s*import[\s\S]*?;$/gm) ?? [];
      if (imports.some(isForbiddenRuntimeImport)) {
        violations.push(relative(uiRoot, file).replace(/\\/g, "/"));
      }
    }

    expect(violations).toEqual([]);
  });
});

function isForbiddenRuntimeImport(statement: string): boolean {
  if (!/\sfrom\s+["']\.\.\/\.\.\/(storage|retrieval|compile|dashboard)\//.test(statement)) {
    return false;
  }
  if (/^\s*import\s+type\b/.test(statement)) {
    return false;
  }

  const specifiers = statement
    .replace(/^\s*import\s*/, "")
    .replace(/\s+from\s+["'][^"']+["'];?\s*$/, "")
    .trim();
  if (specifiers.startsWith("{") && specifiers.endsWith("}")) {
    return specifiers
      .slice(1, -1)
      .split(",")
      .map((specifier) => specifier.trim())
      .filter(Boolean)
      .some((specifier) => !specifier.startsWith("type "));
  }

  return true;
}

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if ([".ts", ".tsx"].includes(extname(entry.name))) return [fullPath];
    return [];
  }));
  return files.flat();
}
