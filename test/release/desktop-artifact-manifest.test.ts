import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const createScript = join(repoRoot, "scripts", "release", "create-desktop-artifact-manifest.mjs");
const validateScript = join(repoRoot, "scripts", "release", "validate-desktop-artifacts.mjs");
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

function makePlatformArtifacts(
  root: string,
  platform: "Windows" | "macOS" | "Linux",
  installer: string,
  updater: string,
) {
  const directory = join(root, `desktop-${platform}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, installer), `${platform}-installer`);
  writeFileSync(join(directory, `${installer}.zip`), `${platform}-zip`);
  writeFileSync(join(directory, updater), `${platform}-updater`);

  const result = run(createScript, [
    "--directory", directory,
    "--platform", platform,
    "--tag", "v0.13.0",
    "--version", "0.13.0",
    "--commit", "abc123",
  ]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return directory;
}

describe("desktop release artifact manifests", () => {
  it("records release metadata and SHA-256 hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-fort-artifacts-"));
    tempDirs.push(root);
    const directory = makePlatformArtifacts(root, "Windows", "MemoryFort-Setup-0.13.0.exe", "latest.yml");

    const manifest = JSON.parse(
      readFileSync(join(directory, "artifact-manifest-Windows.json"), "utf-8"),
    ) as { tag: string; version: string; commit: string; files: Array<{ name: string; sha256: string }> };
    const installer = manifest.files.find((file) => file.name.endsWith(".exe"));

    expect(manifest).toMatchObject({ tag: "v0.13.0", version: "0.13.0", commit: "abc123" });
    expect(installer?.sha256).toBe(
      createHash("sha256").update("Windows-installer").digest("hex"),
    );
  });

  it("accepts one complete, matching artifact set for every platform", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-fort-artifacts-"));
    tempDirs.push(root);
    makePlatformArtifacts(root, "Windows", "MemoryFort-Setup-0.13.0.exe", "latest.yml");
    makePlatformArtifacts(root, "macOS", "MemoryFort-0.13.0-arm64.dmg", "latest-mac.yml");
    makePlatformArtifacts(root, "Linux", "MemoryFort-0.13.0.AppImage", "latest-linux.yml");

    const result = run(validateScript, ["--root", root, "--tag", "v0.13.0"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("desktop artifact set passed");
  });

  it("fails if an artifact changes after its manifest is created", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-fort-artifacts-"));
    tempDirs.push(root);
    const windows = makePlatformArtifacts(root, "Windows", "MemoryFort-Setup-0.13.0.exe", "latest.yml");
    makePlatformArtifacts(root, "macOS", "MemoryFort-0.13.0-arm64.dmg", "latest-mac.yml");
    makePlatformArtifacts(root, "Linux", "MemoryFort-0.13.0.AppImage", "latest-linux.yml");
    // Keep the original byte length so the validator must exercise the hash gate.
    writeFileSync(join(windows, "MemoryFort-Setup-0.13.0.exe"), "tampered-artifact");

    const result = run(validateScript, ["--root", root, "--tag", "v0.13.0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hash mismatch");
  });
});
