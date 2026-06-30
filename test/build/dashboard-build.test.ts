import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../../tsdown.config.js";

const ELECTRON_SHIPPED_ENTRIES = [
  "dist/electron-main.mjs",
  "dist/dashboard/dashboard-service.mjs",
  "dist/dashboard/index-writer.mjs",
  "dist/dashboard/index-concurrency-spike.mjs",
  "dist/dashboard/scheduled-vault-worker.mjs",
  "dist/dashboard/verify-worker.mjs",
];

const RELATIVE_IMPORT_PATTERN =
  /(?:from\s+["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\s+["'](\.{1,2}\/[^"']+)["'])/g;

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function globToRegExp(pattern: string): RegExp {
  const source = toPosixPath(pattern)
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join("[^/]*")
    .replace(/\[\^\/\]\*\[\^\/\]\*/g, ".*");
  return new RegExp(`^${source}$`);
}

function readElectronBuilderFileGlobs(config: string): string[] {
  const parsed = yaml.load(config, { schema: yaml.JSON_SCHEMA }) as { files?: unknown };
  expect(Array.isArray(parsed.files)).toBe(true);
  return (parsed.files as unknown[]).filter((entry): entry is string => typeof entry === "string");
}

function extractRelativeImports(source: string): string[] {
  return Array.from(source.matchAll(RELATIVE_IMPORT_PATTERN), (match) => match[1] ?? match[2] ?? match[3]);
}

function isCoveredByElectronBuilderFiles(path: string, fileGlobs: string[]): boolean {
  return fileGlobs.some((glob) => globToRegExp(glob).test(path));
}

describe("dashboard build robustness", () => {
  it("scopes the server clean so dist/dashboard-ui is not removed", () => {
    expect(Array.isArray(tsdownConfig)).toBe(true);
    const serverBuild = Array.isArray(tsdownConfig) ? tsdownConfig[0] : null;

    expect(serverBuild?.clean).toEqual(expect.arrayContaining([
      "dist/*.mjs",
      "dist/*.d.mts",
      "dist/*.mjs.map",
    ]));
    expect(serverBuild?.clean).not.toEqual(true);
    expect(serverBuild?.clean).not.toContain("dist/dashboard-ui");
  });

  it("makes npm run build finish by building the dashboard UI", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["build"]).toContain("npm run build:ui");
  });

  it("builds and packages the Electron dashboard utility service", async () => {
    const entries = Array.isArray(tsdownConfig)
      ? tsdownConfig.flatMap((item) => Object.keys((item as { entry?: Record<string, string> }).entry ?? {}))
      : [];
    expect(entries).toContain("dashboard/dashboard-service");
    expect(entries).toContain("dashboard/index-writer");
    expect(entries).toContain("dashboard/index-concurrency-spike");

    const electronBuilder = await readFile(resolve(process.cwd(), "electron-builder.yml"), "utf8");
    expect(electronBuilder).toContain("dist/dashboard/dashboard-service.mjs");
    expect(electronBuilder).toContain("dist/dashboard/index-writer.mjs");
    expect(electronBuilder).toContain("dist/dashboard/index-concurrency-spike.mjs");
  });

  it("packages every relative import used by built Electron entries", async () => {
    const distRoot = resolve(process.cwd(), "dist");
    if (!existsSync(distRoot)) {
      return;
    }

    const electronBuilder = await readFile(resolve(process.cwd(), "electron-builder.yml"), "utf8");
    const fileGlobs = readElectronBuilderFileGlobs(electronBuilder);
    const unpackagedImports: string[] = [];

    for (const entry of ELECTRON_SHIPPED_ENTRIES) {
      const entryPath = resolve(process.cwd(), entry);
      expect(existsSync(entryPath), `${entry} should exist in built dist`).toBe(true);

      const source = await readFile(entryPath, "utf8");
      for (const specifier of extractRelativeImports(source)) {
        const target = toPosixPath(relative(process.cwd(), resolve(dirname(entryPath), specifier)));
        if (!isCoveredByElectronBuilderFiles(target, fileGlobs)) {
          unpackagedImports.push(`${entry} imports ${specifier} -> ${target}`);
        }
      }
    }

    expect(unpackagedImports).toEqual([]);
  });
});
