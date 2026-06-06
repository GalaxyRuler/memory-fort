import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scannerPath = resolve(process.cwd(), "scripts", "scan-leaks.mjs");

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
    expect(result.stdout).toContain(`src/public.ts:1: ${token}`);
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
    expect(result.stdout).toContain(`src/paths.ts:1: ${escapedPath}`);
    expect(result.stdout).toContain(`src/paths.ts:2: ${slashPath}`);
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
    expect(result.stdout).toContain(`README.md:1: ${escapedUserPath}`);
    expect(result.stdout).toContain(["Claude", "Code", "Projects"].join(""));
    expect(result.stdout).toContain(`src/example.json:2: ${jsonRenderedUserPath}`);
    expect(result.stdout).toContain(["Codex", "Projects"].join(""));
  });

  it("allows owner name tokens in package.json", async () => {
    const token = ["Abdul", "lah"].join("");
    await writeText("package.json", JSON.stringify({ author: token }));

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("flags owner name tokens outside allowlist files", async () => {
    const token = ["Abdul", "lah"].join("");
    await writeText("src/about.ts", `export const owner = "${token}";\n`);

    const result = await runScan(["--root", tmp, "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([{
      path: "src/about.ts",
      line: 1,
      token,
    }]);
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

  it("does not flag denylist tokens in quarantined paths", async () => {
    const token = ["C:", "\\", "Users", "\\", "Admin"].join("");
    await writeText("docs/private-brief.md", `Path: ${token}\n`);
    await writeText("src/cli/commands/install-vps.ts", `const host = "${["srv", "1317946"].join("")}";\n`);

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(0);
  });

  it("flags denylist tokens in public release docs", async () => {
    const token = ["C:", "\\", "Users", "\\", "Admin"].join("");
    await writeText("docs/compatibility-matrix.md", `Path: ${token}\n`);
    await writeText("docs/release-evidence/2026-06-07-v1.1-credibility.md", `Evidence path: ${token}\n`);
    await writeText("docs/release-evidence/private.txt", `Private evidence path: ${token}\n`);

    const result = await runScan(["--root", tmp]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`docs/compatibility-matrix.md:1: ${token}`);
    expect(result.stdout).toContain(`docs/release-evidence/2026-06-07-v1.1-credibility.md:1: ${token}`);
    expect(result.stdout).not.toContain("docs/release-evidence/private.txt");
  });

  async function writeText(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
});

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
