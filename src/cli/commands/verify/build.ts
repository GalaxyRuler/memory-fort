import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, pass, type CheckDescriptor, type VerifyCheckResult } from "./types.js";

declare const __APP_VERSION__: string | undefined;
declare const __MEMORY_BUILD_VERSION__: string | undefined;

const ID = "build.version-match";
const LABEL = "dashboard, CLI build, and package versions match";
const VERSION_FILE_EXTENSIONS = new Set([".html", ".js", ".mjs"]);

export function evaluateVersionMatch(
  appVersion: string | undefined,
  buildVersion: string | undefined,
  pkgVersion: string | undefined,
): VerifyCheckResult {
  const versions = {
    app: normalizeVersion(appVersion),
    build: normalizeVersion(buildVersion),
    package: normalizeVersion(pkgVersion),
  };
  const values = Object.values(versions);
  if (values.every(Boolean) && new Set(values).size === 1) {
    return pass(ID, LABEL, `version ${versions.package}`);
  }
  return fail(
    ID,
    LABEL,
    "run `npm run build` so dashboard assets and CLI embeds match package.json",
    `app=${displayVersion(versions.app)} build=${displayVersion(versions.build)} package=${displayVersion(versions.package)}`,
  );
}

export const buildVersionMatchCheck: CheckDescriptor = {
  id: ID,
  label: LABEL,
  roles: ["operator"],
  run: async () => {
    const pkgVersion = readPackageVersion();
    return evaluateVersionMatch(readAppVersion(pkgVersion), readBuildVersion(), pkgVersion);
  },
};

function normalizeVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  return trimmed ? trimmed : undefined;
}

function displayVersion(version: string | undefined): string {
  return version ?? "(missing)";
}

function readBuildVersion(): string | undefined {
  return typeof __MEMORY_BUILD_VERSION__ !== "undefined" ? __MEMORY_BUILD_VERSION__ : undefined;
}

function readAppVersion(pkgVersion: string | undefined): string | undefined {
  if (typeof __APP_VERSION__ !== "undefined") return __APP_VERSION__;
  if (!pkgVersion) return undefined;
  return dashboardDistContainsVersion(pkgVersion) ? pkgVersion : undefined;
}

function readPackageVersion(): string | undefined {
  for (const packagePath of packageJsonCandidates()) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf-8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version;
    } catch {
      // Try the next runtime layout candidate.
    }
  }
  return undefined;
}

function packageJsonCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return uniqueResolved([
    join(process.cwd(), "package.json"),
    join(moduleDir, "package.json"),
    join(moduleDir, "..", "package.json"),
    join(moduleDir, "..", "..", "package.json"),
    join(moduleDir, "..", "..", "..", "package.json"),
    join(moduleDir, "..", "..", "..", "..", "package.json"),
  ]);
}

function dashboardDistContainsVersion(version: string): boolean {
  for (const distRoot of dashboardDistCandidates()) {
    if (distFilesContainVersion(distRoot, version)) return true;
  }
  return false;
}

function dashboardDistCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return uniqueResolved([
    join(process.cwd(), "dist", "dashboard-ui"),
    join(moduleDir, "dashboard-ui"),
    join(moduleDir, "..", "dashboard-ui"),
    join(moduleDir, "..", "..", "dashboard-ui"),
    join(moduleDir, "..", "..", "..", "dist", "dashboard-ui"),
    join(moduleDir, "..", "..", "..", "..", "dist", "dashboard-ui"),
  ]);
}

function distFilesContainVersion(root: string, version: string): boolean {
  if (!existsSync(root)) return false;
  for (const filePath of walkVersionFiles(root)) {
    try {
      if (readFileSync(filePath, "utf-8").includes(version)) return true;
    } catch {
      // Ignore unreadable files; absence of a readable match fails the check.
    }
  }
  return false;
}

function* walkVersionFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkVersionFiles(entryPath);
    } else if (entry.isFile() && VERSION_FILE_EXTENSIONS.has(extname(entry.name))) {
      yield entryPath;
    }
  }
}

function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}
