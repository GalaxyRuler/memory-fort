import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../../tsdown.config.js";

const REQUIRED_NATIVE_FILE_GLOBS = [
  "node_modules/better-sqlite3/**",
  "node_modules/bindings/**",
  "node_modules/file-uri-to-path/**",
  "node_modules/sqlite-vec/**",
  "node_modules/sqlite-vec-*/**",
  "vendor/sqlite-vec/**",
];

const REQUIRED_NATIVE_EXTERNALS = [
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  "sqlite-vec",
];

const SQLITE_VEC_PLATFORM_PACKAGE = "sqlite-vec-windows-x64";
const PE_MACHINE_ARM64 = 0xaa64;

const SHIPPED_NATIVE_RUNTIME_ENTRIES = [
  "electron-main",
  "dashboard/dashboard-service",
  "index/native/capability-probe",
];

type ElectronBuilderConfig = {
  asar?: unknown;
  files?: unknown;
};

type TsdownConfigItem = {
  entry?: Record<string, string>;
  deps?: {
    neverBundle?: unknown[];
  };
  outputOptions?: {
    codeSplitting?: boolean;
  };
};

function asTsdownConfigs(): TsdownConfigItem[] {
  expect(Array.isArray(tsdownConfig)).toBe(true);
  return tsdownConfig as TsdownConfigItem[];
}

function findConfigForEntry(entryName: string): TsdownConfigItem {
  const config = asTsdownConfigs().find((item) => Object.hasOwn(item.entry ?? {}, entryName));
  expect(config, `missing tsdown entry ${entryName}`).toBeDefined();
  return config as TsdownConfigItem;
}

function hasStringExternal(externals: unknown[], external: string): boolean {
  return externals.some((item) => item === external);
}

function hasSqliteVecPlatformExternal(externals: unknown[]): boolean {
  return externals.some((item) => item instanceof RegExp && item.test(SQLITE_VEC_PLATFORM_PACKAGE));
}

function readPeMachine(bytes: Buffer): number {
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("vec0.dll is not a PE/MZ binary");
  }

  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
    throw new Error("vec0.dll does not contain a PE header");
  }

  return bytes.readUInt16LE(peOffset + 4);
}

describe("native packaging contract", () => {
  it("ships native runtime files outside asar", async () => {
    const source = await readFile(resolve(process.cwd(), "electron-builder.yml"), "utf8");
    const config = yaml.load(source, { schema: yaml.JSON_SCHEMA }) as ElectronBuilderConfig;

    // Mutation proof: change electron-builder.yml to `asar: true`; native modules would be packed and this fails.
    expect(config.asar).toBe(false);

    expect(Array.isArray(config.files)).toBe(true);
    const files = config.files as unknown[];
    const stringFiles = files.filter((entry): entry is string => typeof entry === "string");

    // Mutation proof: remove any native files glob; the exact membership check fails for that runtime path.
    for (const requiredGlob of REQUIRED_NATIVE_FILE_GLOBS) {
      expect(stringFiles, `electron-builder files must include ${requiredGlob}`).toContain(requiredGlob);
    }
  });

  it("keeps shipped native-runtime entries externalized and unsplit", () => {
    for (const entryName of SHIPPED_NATIVE_RUNTIME_ENTRIES) {
      const config = findConfigForEntry(entryName);
      const neverBundle = config.deps?.neverBundle ?? [];

      // Mutation proof: set this entry to codeSplitting:true or remove the false override; this fails.
      expect(config.outputOptions?.codeSplitting, `${entryName} must be a self-contained entry`).toBe(false);

      // Mutation proof: drop a nativeRuntimeExternals member; each shipped runtime entry loses it and this fails.
      for (const external of REQUIRED_NATIVE_EXTERNALS) {
        expect(hasStringExternal(neverBundle, external), `${entryName} must externalize ${external}`).toBe(true);
      }

      // Mutation proof: remove the sqlite-vec-* pattern; platform packages can be bundled/dropped and this fails.
      expect(
        hasSqliteVecPlatformExternal(neverBundle),
        `${entryName} must externalize sqlite-vec platform packages`,
      ).toBe(true);
    }
  });

  it("keeps the vendored win-arm64 sqlite-vec manifest chained to vec0.dll", async () => {
    const manifestPath = resolve(process.cwd(), "vendor/sqlite-vec/win32-arm64/manifest.json");
    const binaryPath = resolve(process.cwd(), "vendor/sqlite-vec/win32-arm64/vec0.dll");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      target?: { platform?: string; arch?: string; file?: string; peMachine?: string };
      output?: { sha256?: string; size?: number };
    };
    const binary = await readFile(binaryPath);
    const binaryStat = await stat(binaryPath);
    const sha256 = createHash("sha256").update(binary).digest("hex");
    const peMachine = readPeMachine(binary);

    expect(manifest.target).toMatchObject({
      platform: "win32",
      arch: "arm64",
      file: "vec0.dll",
    });

    // Mutation proof: edit manifest sha256/size/peMachine or replace vec0.dll; the manifest-to-binary chain fails.
    expect(manifest.output?.sha256).toBe(sha256);
    expect(manifest.output?.size).toBe(binaryStat.size);
    expect(manifest.target?.peMachine).toBe("ARM64");
    expect(peMachine).toBe(PE_MACHINE_ARM64);
  });
});
