import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isReleaseQuarantined } from "../../scripts/release/quarantine.mjs";
import { scanTarget } from "../../scripts/scan-leaks.mjs";

const execFileAsync = promisify(execFile);
const scannerPath = resolve(process.cwd(), "scripts", "scan-leaks.mjs");
const REVIEWED_TRACKED_QUARANTINE_PATHS = [
  // Developer-tool launch metadata; any additional tracked match requires deliberate review.
  ".claude/launch.json",
];

describe("scan-leaks release gate", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "scan-leaks-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports a planted denylist token and exits 1", async () => {
    const token = ["srv", "1317946"].join("");
    await writeText("src/public.ts", `export const host = "${token}";\n`);

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("src/public.ts:1: denied content");
    expect(result.stdout).not.toContain(token);
  });

  it("reports private project path literals in escaped and slash forms", async () => {
    const escapedPath = ["C:", "\\", "\\", "Codex", "Projects"].join("");
    const slashPath = ["C:", "/", "Codex", "Projects"].join("");
    await writeText("src/paths.ts", [
      `export const escapedPath = "${escapedPath}";`,
      `export const slashPath = "${slashPath}";`,
      "",
    ].join("\n"));

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("src/paths.ts:1: denied content");
    expect(result.stdout).toContain("src/paths.ts:2: denied content");
    expect(result.stdout).not.toContain(escapedPath);
    expect(result.stdout).not.toContain(slashPath);
  });

  it("reports escaped user-profile paths in source files", async () => {
    const escapedUserPath = ["C:", "\\", "\\", "Users", "\\", "\\", "Admin"].join("");
    const repeatedEscapedUserPath = ["C:", "\\", "\\", "\\", "\\", "Users", "\\", "\\", "\\", "\\", "Admin"].join("");
    await writeText("src/paths.ts", [
      `export const escapedUserPath = "${escapedUserPath}";`,
      `export const repeatedEscapedUserPath = "${repeatedEscapedUserPath}";`,
      "",
    ].join("\n"));

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("src/paths.ts:1: denied content");
    expect(result.stdout).toContain("src/paths.ts:2: denied content");
    expect(result.stdout).not.toContain(escapedUserPath);
    expect(result.stdout).not.toContain(repeatedEscapedUserPath);
  });

  it("reports escaped user-profile paths and private project-root slugs in public examples", async () => {
    const escapedUserPath = ["C:", "\\", "\\", "Users", "\\", "\\", "Admin"].join("");
    const escapedProjectPath = `${escapedUserPath}${["\\", "\\", "Claude", "Code", "Projects"].join("")}`;
    const jsonEscapedProjectPath = [
      "C:",
      "\\",
      "\\",
      "Users",
      "\\",
      "\\",
      "Admin",
      "\\",
      "\\",
      "Codex",
      "Projects",
    ].join("");
    const jsonRenderedUserPath = JSON.stringify(jsonEscapedProjectPath).match(/^"(.+?Admin)/)?.[1] ?? "";
    await writeText("README.md", `example: "${escapedProjectPath}"\n`);
    await writeText("src/example.json", `${JSON.stringify({ cwd: jsonEscapedProjectPath }, null, 2)}\n`);

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("README.md:1: denied content");
    expect(result.stdout).toContain("src/example.json:2: denied content");
    expect(result.stdout).not.toContain(escapedUserPath);
    expect(result.stdout).not.toContain(jsonRenderedUserPath);
  });

  it("allows intentional owner attribution in repository attribution files", async () => {
    const owner = ["Abdul", "lah"].join("");
    await writeText("package.json", JSON.stringify({ author: owner }));
    await writeText("AUTHORSHIP.md", `Project owner: ${owner}\n`);
    await writeText("LICENSE", `Copyright (c) ${owner}\n`);
    await writeText("LICENSE-NOTICE.md", `Project attribution: ${owner}\n`);

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("scans repository attribution files outside the narrow owner allowance", async () => {
    const owner = ["Abdul", "lah"].join("");
    const token = ["srv", "1317946"].join("");
    await writeText("package.json", JSON.stringify({ author: owner, privateEndpoint: token }));
    await writeText("LICENSE-NOTICE.md", [
      `Project attribution: ${owner}`,
      `Private endpoint: ${token}`,
      "",
    ].join("\n"));

    const result = await runScan(["--root", tmp, "--json"]);
    const hits = result.stdout
      ? JSON.parse(result.stdout) as Array<{ path: string; line: number }>
      : [];

    expect(result.exitCode).toBe(1);
    expect(hits).toEqual([
      { path: "LICENSE-NOTICE.md", line: 2 },
      { path: "package.json", line: 1 },
    ]);
    expect(result.stdout.includes(owner)).toBe(false);
    expect(result.stdout.includes(token)).toBe(false);
  });

  it("flags owner name tokens outside allowlist files", async () => {
    const token = ["Abdul", "lah"].join("");
    await writeText("src/about.ts", `export const owner = "${token}";\n`);

    const result = await runScan(["--root", tmp, "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([{
      path: "src/about.ts",
      line: 1,
    }]);
    expect(result.stdout).not.toContain(token);
  });

  it("allows public owner and predecessor project names anywhere", async () => {
    await writeText("src/public.ts", [
      "GalaxyRuler owns the public repository.",
      "agentmemory was the public predecessor.",
      "memory-fort is the package name.",
      "",
    ].join("\n"));

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(0);
  });

  it("allows OpenClaw as a public supported platform name", async () => {
    await writeText("src/install-openclaw.ts", [
      "export const platform = 'openclaw';",
      "export const label = 'OpenClaw';",
      "",
    ].join("\n"));

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("scans ordinary public documentation and release scripts", async () => {
    const token = ["C:", "\\", "Users", "\\", "Admin"].join("");
    await writeText("docs/private-brief.md", `Path: ${token}\n`);
    await writeText("src/cli/commands/install-vps.ts", `const host = "${["srv", "1317946"].join("")}";\n`);

    const result = await runScan(["--root", tmp]);

    await writeText("scripts/release/private-brief.mjs", `Path: ${token}\n`);
    const releaseResult = await runScan(["--root", tmp]);

    expect([result.exitCode, releaseResult.exitCode]).toEqual([1, 1]);
    expect(result.stdout).toContain("docs/private-brief.md:1");
    expect(releaseResult.stdout).toContain("scripts/release/private-brief.mjs:1");
    expect(result.stdout).not.toContain(token);
    expect(releaseResult.stdout).not.toContain(token);
  });

  it("scans tracked docs and release-script paths through Git inventory", async () => {
    const syntheticPathMarker = ["One", "Drive"].join("");
    const docPath = `docs/example-${syntheticPathMarker}.md`;
    const releaseScriptPath = `scripts/release/example-${syntheticPathMarker}.mjs`;
    await writeText(docPath, "# Public fixture\n");
    await writeText(releaseScriptPath, "export {};\n");
    await execFileAsync("git", ["init", "--quiet"], { cwd: tmp, windowsHide: true });
    await execFileAsync("git", ["add", "--", docPath, releaseScriptPath], {
      cwd: tmp,
      windowsHide: true,
    });

    const result = await runScan(["--root", tmp, "--json"]);
    const hits = JSON.parse(result.stdout) as Array<{ path: string; line: number; kind?: string }>;

    expect(result.exitCode).toBe(1);
    expect(hits).toHaveLength(2);
    expect(hits).toEqual(expect.arrayContaining([
      { path: "docs/example-[REDACTED].md", line: 0, kind: "path" },
      { path: "scripts/release/example-[REDACTED].mjs", line: 0, kind: "path" },
    ]));
    expect(result.stdout).not.toContain(syntheticPathMarker);
  });

  it("flags denylist tokens in public release docs", async () => {
    const token = ["C:", "\\", "Users", "\\", "Admin"].join("");
    await writeText("docs/compatibility-matrix.md", `Path: ${token}\n`);
    await writeText("docs/release-evidence/2026-06-07-v1.1-credibility.md", `Evidence path: ${token}\n`);
    await writeText("docs/release-evidence/private.txt", `Private evidence path: ${token}\n`);

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("docs/compatibility-matrix.md:1: denied content");
    expect(result.stdout).toContain("docs/release-evidence/2026-06-07-v1.1-credibility.md:1: denied content");
    expect(result.stdout).toContain("docs/release-evidence/private.txt:1: denied content");
    expect(result.stdout).not.toContain(token);
  });

  it("reports dist-only infra token hits as json", async () => {
    const token = ["tail", "6916d8"].join("");
    await writeText("dist/cli.mjs", `const route = "${token}";\n`);

    const result = await runScan(["--root", tmp, "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([{
      path: "dist/cli.mjs",
      line: 1,
      scope: "dist",
    }]);
    expect(result.stdout).not.toContain(token);
  });

  it("builds before scanning repository leaks during prepublish", async () => {
    const manifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.prepublishOnly).toBe("npm run build && npm run scan:leaks");
  });

  it("requires the Windows packaging command to scan the unpacked shipped app", async () => {
    const manifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.["electron:build"]).toContain("scan:leaks:package");
    expect(manifest.scripts?.["scan:leaks:package"]).toContain("--expect-roots 2");
  });

  it("scans a packaged app root outside a Git worktree", async () => {
    const token = ["srv", "1317946"].join("");
    const appRoot = join(tmp, "electron-installer", "win-unpacked", "resources", "app");
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(appRoot, "main.mjs"), `export const endpoint = "${token}";\n`);

    const result = await runScan(["--packaged-root", appRoot]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("main.mjs:1: denied content");
    expect(result.stdout).not.toContain(token);
  });

  it("allows intentional owner attribution in packaged attribution files", async () => {
    const owner = ["Abdul", "lah"].join("");
    const appRoot = join(tmp, "attribution-only");
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ author: owner }));
    await writeFile(join(appRoot, "AUTHORSHIP.md"), `Project owner: ${owner}\n`);
    await writeFile(join(appRoot, "LICENSE"), `Copyright (c) ${owner}\n`);
    await writeFile(join(appRoot, "LICENSE-NOTICE.md"), `Project attribution: ${owner}\n`);

    const result = await runScan(["--packaged-root", appRoot]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("scans packaged attribution files outside the narrow owner allowance", async () => {
    const owner = ["Abdul", "lah"].join("");
    const token = ["srv", "1317946"].join("");
    const appRoot = join(tmp, "app");
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ author: owner, privateEndpoint: token }));
    await writeFile(join(appRoot, "AUTHORSHIP.md"), [
      `Project owner: ${owner}`,
      `Private endpoint: ${token}`,
      "",
    ].join("\n"));

    const result = await runScan(["--packaged-root", appRoot, "--json"]);
    const hits = JSON.parse(result.stdout) as Array<{ path: string; line: number }>;

    expect(result.exitCode).toBe(1);
    expect(hits).toEqual([
      { path: "AUTHORSHIP.md", line: 2 },
      { path: "package.json", line: 1 },
    ]);
    expect(result.stdout.includes(owner)).toBe(false);
    expect(result.stdout.includes(token)).toBe(false);
  });

  it("scans packaged file and directory names as redacted path hits", async () => {
    const token = ["srv", "1317946"].join("");
    const appRoot = join(tmp, "path-names");
    await writeText(`path-names/dir-${token}/clean.js`, "export const clean = true;\n");
    await writeText(`path-names/clean-${token}.js`, "export const clean = true;\n");

    const result = await runScan(["--packaged-root", appRoot, "--json"]);
    const hits = JSON.parse(result.stdout) as Array<{ path: string; line: number; kind?: string }>;

    expect(result.exitCode).toBe(1);
    expect(hits).toEqual(expect.arrayContaining([
      { path: "dir-[REDACTED]", line: 0, kind: "path" },
      { path: "clean-[REDACTED].js", line: 0, kind: "path" },
    ]));
    expect(result.stdout).not.toContain(token);
  });

  it("rejects a packaged root that contains only fully allowlisted files", async () => {
    const appRoot = join(tmp, "allowlisted-only");
    await mkdir(appRoot, { recursive: true });
    await writeText("allowlisted-only/assets/embedding-models/bge-small-en-v1.5/tokenizer.json", "{}\n");

    const result = await runScan(["--packaged-root", appRoot]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("package scan root contains no scan-eligible files");
  });

  it("fails closed when a packaged subtree cannot be enumerated", async () => {
    let readdirCalls = 0;
    const fileSystem = {
      access: async () => undefined,
      readdir: async () => {
        readdirCalls += 1;
        if (readdirCalls === 1) return [directoryEntry("locked")];
        throw new Error("permission denied");
      },
      readFile: async () => "",
      stat: async () => ({ isFile: () => false, isDirectory: () => true }),
    };

    await expect(scanTarget(
      { root: "package", prefix: "" },
      { quarantine: false, prefix: "", requireFiles: true },
      { fileSystem },
    )).rejects.toThrow("package scan could not enumerate locked: permission denied");
  });

  it("fails closed when a packaged file cannot be read", async () => {
    const fileSystem = {
      access: async () => undefined,
      readdir: async () => [fileEntry("payload.js")],
      readFile: async () => {
        throw new Error("permission denied");
      },
      stat: async () => ({ isFile: () => true, isDirectory: () => false }),
    };

    await expect(scanTarget(
      { root: "package", prefix: "" },
      { quarantine: false, prefix: "", requireFiles: true },
      { fileSystem },
    )).rejects.toThrow("package scan could not read payload.js: permission denied");
  });

  it("rejects symbolic links in a packaged payload", async () => {
    const fileSystem = {
      access: async () => undefined,
      readdir: async () => [symlinkEntry("linked.js")],
      readFile: async () => "",
      stat: async () => ({ isFile: () => false, isDirectory: () => false }),
    };

    await expect(scanTarget(
      { root: "package", prefix: "" },
      { quarantine: false, prefix: "", requireFiles: true },
      { fileSystem },
    )).rejects.toThrow("package scan does not support symbolic link: linked.js");
  });

  it("fails closed on an unsupported packaged directory entry", async () => {
    const fileSystem = {
      access: async () => undefined,
      readdir: async () => [unknownEntry("fifo")],
      readFile: async () => "",
      stat: async () => ({ isFile: () => false, isDirectory: () => false }),
    };

    await expect(scanTarget(
      { root: "package", prefix: "" },
      { quarantine: false, prefix: "", requireFiles: true },
      { fileSystem },
    )).rejects.toThrow("package scan encountered unsupported entry: fifo");
  });

  it("fails closed when a packaged dirent disagrees with stat", async () => {
    const fileAsDirectory = {
      access: async () => undefined,
      readdir: async () => [fileEntry("payload.js")],
      readFile: async () => "",
      stat: async () => ({ isFile: () => false, isDirectory: () => true }),
    };
    const directoryAsFile = {
      access: async () => undefined,
      readdir: async () => [directoryEntry("assets")],
      readFile: async () => "",
      stat: async () => ({ isFile: () => true, isDirectory: () => false }),
    };

    await expect(scanTarget(
      { root: "package", prefix: "" },
      { quarantine: false, prefix: "", requireFiles: true },
      { fileSystem: fileAsDirectory },
    )).rejects.toThrow("package scan entry type mismatch: payload.js");
    await expect(scanTarget(
      { root: "package", prefix: "" },
      { quarantine: false, prefix: "", requireFiles: true },
      { fileSystem: directoryAsFile },
    )).rejects.toThrow("package scan entry type mismatch: assets");
  });

  it("redacts tokens from strict packaged scan diagnostics", async () => {
    const token = ["srv", "1317946"].join("");
    const fileSystem = {
      access: async () => undefined,
      readdir: async () => [fileEntry(`${token}.js`)],
      readFile: async () => {
        throw new Error(`${token} unreadable`);
      },
      stat: async () => ({ isFile: () => true, isDirectory: () => false }),
    };
    let failure: unknown;
    try {
      await scanTarget(
        { root: "package", prefix: "" },
        { quarantine: false, prefix: "", requireFiles: true },
        { fileSystem },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("[REDACTED]");
    expect((failure as Error).message).not.toContain(token);
  });

  it("redacts repository dist paths when enumeration fails", async () => {
    const token = ["srv", "1317946"].join("");
    const enumerateFailure = repositoryDistFileSystem(async (path) => {
      if (path.endsWith(`${token}-dist`)) throw new Error("permission denied");
      if (path.endsWith("dist")) return [directoryEntry(`${token}-dist`)];
      return [directoryEntry("dist")];
    });

    let failure: unknown;
    try {
      await scanTarget(
        { root: "repo", prefix: "" },
        { quarantine: true, prefix: "", requireFiles: false },
        { fileSystem: enumerateFailure },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "repository scan could not enumerate dist/[REDACTED]-dist: permission denied",
    );
    expect((failure as Error).message).not.toContain(token);
  });

  it("redacts repository dist paths when file reads fail", async () => {
    const token = ["srv", "1317946"].join("");
    const readFailure = repositoryDistFileSystem(async (path) => {
      if (path.endsWith("dist")) return [fileEntry(`unreadable-${token}.mjs`)];
      return [directoryEntry("dist")];
    }, async () => {
      throw new Error("permission denied");
    });

    let failure: unknown;
    try {
      await scanTarget(
        { root: "repo", prefix: "" },
        { quarantine: true, prefix: "", requireFiles: false },
        { fileSystem: readFailure },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "repository scan could not read dist/unreadable-[REDACTED].mjs: permission denied",
    );
    expect((failure as Error).message).not.toContain(token);
  });

  it("scans denylist tokens across every discovered packaged payload", async () => {
    const token = ["C:", "\\", "Users", "\\", "Admin"].join("");
    await writeText("electron-installer/win-unpacked/resources/app/dist/electron-main.mjs", `export const buildPath = "${token}";\n`);
    await writeText("electron-installer/win-arm64-unpacked/resources/app/node_modules/example/index.js", `module.exports = "${token}";\n`);
    await writeText("electron-installer/mac-arm64/MemoryFort.app/Contents/Resources/app/dist/main.mjs", `export const macBuildPath = "${token}";\n`);

    const result = await runScan(["--packaged-output", join(tmp, "electron-installer"), "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "win-unpacked/resources/app/dist/electron-main.mjs" }),
      expect.objectContaining({ path: "win-arm64-unpacked/resources/app/node_modules/example/index.js" }),
      expect.objectContaining({ path: "mac-arm64/MemoryFort.app/Contents/Resources/app/dist/main.mjs" }),
    ]));
    expect(result.stdout).not.toContain(token);
  });

  it("requires the exact number of discovered packaged app roots", async () => {
    const output = join(tmp, "expected-roots");
    await writeText("expected-roots/win-unpacked/resources/app/main.mjs", "export const ok = true;\n");
    await writeText("expected-roots/win-arm64-unpacked/resources/app/main.mjs", "export const ok = true;\n");

    const complete = await runScan(["--packaged-output", output, "--expect-roots", "2"]);
    const incomplete = await runScan(["--packaged-output", output, "--expect-roots", "3"]);

    expect(complete.exitCode).toBe(0);
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.stderr).toContain("package scan output expected 3 unpacked app roots, found 2");
  });

  it("rejects an invalid expected packaged app-root count", async () => {
    const result = await runScan(["--packaged-output", tmp, "--expect-roots", "0"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--expect-roots must be a positive integer");
  });

  it("fails closed when an explicit packaged root is missing or empty", async () => {
    const missingRoot = await runScan(["--root", join(tmp, "missing-root")]);
    const missing = await runScan(["--packaged-root", join(tmp, "missing")]);
    const missingOutput = await runScan(["--packaged-output", join(tmp, "missing-output")]);
    const emptyRoot = join(tmp, "empty-package");
    await mkdir(emptyRoot, { recursive: true });
    const empty = await runScan(["--packaged-root", emptyRoot]);
    const outputWithoutApps = join(tmp, "output-without-apps");
    await mkdir(outputWithoutApps, { recursive: true });
    const noAppRoots = await runScan(["--packaged-output", outputWithoutApps]);

    expect(missing.exitCode).toBe(1);
    expect(missingRoot.exitCode).toBe(1);
    expect(missingRoot.stderr).toContain("scan root does not exist");
    expect(missing.stderr).toContain("package scan root does not exist");
    expect(missingOutput.exitCode).toBe(1);
    expect(missingOutput.stderr).toContain("package scan output does not exist");
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("package scan root contains no files");
    expect(noAppRoots.exitCode).toBe(1);
    expect(noAppRoots.stderr).toContain("package scan output contains no unpacked app roots");
  });

  it("reports tracked quarantine drift without exposing path values", () => {
    const unexpectedPath = ".claude/review-required.json";
    const missingPath = ".claude/reviewed-config.json";
    const diagnostics = [
      captureFailure(() => assertTrackedQuarantineCoverage([unexpectedPath], [])),
      captureFailure(() => assertTrackedQuarantineCoverage([], [missingPath])),
    ].join("\n");

    expect(diagnostics).toContain("unexpectedCount");
    expect(diagnostics).toContain("missingCount");
    expect(diagnostics).not.toContain(unexpectedPath);
    expect(diagnostics).not.toContain(missingPath);
  });

  it("requires every tracked quarantined path to be explicitly reviewed", async () => {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    const trackedPaths = stdout.split("\0").filter(Boolean);
    const trackedQuarantinedPaths = trackedPaths.filter(isReleaseQuarantined).sort();

    assertTrackedQuarantineCoverage(
      trackedQuarantinedPaths,
      REVIEWED_TRACKED_QUARANTINE_PATHS,
    );
  });

  async function writeText(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
});

function assertTrackedQuarantineCoverage(
  actual: readonly string[],
  reviewed: readonly string[],
): void {
  const actualSet = new Set(actual);
  const reviewedSet = new Set(reviewed);
  const unexpectedCount = [...actualSet].filter((path) => !reviewedSet.has(path)).length;
  const missingCount = [...reviewedSet].filter((path) => !actualSet.has(path)).length;

  expect({ unexpectedCount, missingCount }).toEqual({
    unexpectedCount: 0,
    missingCount: 0,
  });
}

function captureFailure(operation: () => void): string {
  try {
    operation();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function runScan(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [scannerPath, ...args], {
      encoding: "utf-8",
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function directoryEntry(name: string) {
  return { name, isDirectory: () => true, isFile: () => false };
}

function fileEntry(name: string) {
  return { name, isDirectory: () => false, isFile: () => true };
}

function symlinkEntry(name: string) {
  return { name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true };
}

function unknownEntry(name: string) {
  return { name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false };
}

function repositoryDistFileSystem(
  readdir: (path: string) => Promise<ReturnType<typeof directoryEntry>[] | ReturnType<typeof fileEntry>[]>,
  readFile: (path: string) => Promise<string> = async () => "",
) {
  return {
    access: async (path: string) => {
      if (path.endsWith(".git")) throw new Error("not found");
    },
    readdir,
    readFile,
    stat: async (path: string) => ({
      isFile: () => path.endsWith(".mjs"),
      isDirectory: () => path.endsWith("dist"),
    }),
  };
}
