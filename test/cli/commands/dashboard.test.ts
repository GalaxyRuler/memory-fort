import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDashboardCommand, runDashboard } from "../../../src/cli/commands/dashboard.js";
import type { RunningServer, ServerOptions } from "../../../src/dashboard/server.js";

describe("runDashboard", () => {
  let tmp: string;
  let originalMemoryRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-dashboard-cli-"));
    originalMemoryRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = join(tmp, ".memory");
  });

  afterEach(async () => {
    if (originalMemoryRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = originalMemoryRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("starts the dashboard with local defaults and opens the /memory/ URL", async () => {
    const close = vi.fn(async () => undefined);
    const createServer = vi.fn(async (_opts: ServerOptions): Promise<RunningServer> => ({
      host: "127.0.0.1",
      port: 4410,
      close,
    }));
    const openBrowser = vi.fn(async () => undefined);
    const stdout: string[] = [];

    const result = await runDashboard({
      createServer,
      openBrowser,
      stdout: (line) => stdout.push(line),
    });

    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      vaultRoot: join(tmp, ".memory"),
      host: "127.0.0.1",
      port: 4410,
      dashboardDistRoot: resolve(process.cwd(), "dist", "dashboard-ui"),
    }));
    expect(result.url).toBe("http://127.0.0.1:4410/memory/");
    expect(stdout).toEqual([
      "Memory dashboard: http://127.0.0.1:4410/memory/",
      `Vault root: ${join(tmp, ".memory")}`,
    ]);
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:4410/memory/");

    await result.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("honors host, port, dashboardDistRoot, and --no-open", async () => {
    const distRoot = join(tmp, "ui-dist");
    await mkdir(distRoot, { recursive: true });
    await writeFile(join(distRoot, "index.html"), "<!doctype html>\n");
    const createServer = vi.fn(async (opts: ServerOptions): Promise<RunningServer> => ({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 4410,
      close: async () => undefined,
    }));
    const openBrowser = vi.fn(async () => undefined);

    const result = await runDashboard({
      host: "0.0.0.0",
      port: 4500,
      noOpen: true,
      dashboardDistRoot: distRoot,
      createServer,
      openBrowser,
      stdout: () => undefined,
    });

    expect(result.url).toBe("http://0.0.0.0:4500/memory/");
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      host: "0.0.0.0",
      port: 4500,
      dashboardDistRoot: distRoot,
    }));
    expect(openBrowser).not.toHaveBeenCalled();
    await result.close();
  });

  it("prefers an explicit vault root and prints it during startup", async () => {
    const explicitRoot = join(tmp, "one-drive-vault");
    const createServer = vi.fn(async (opts: ServerOptions): Promise<RunningServer> => ({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 4410,
      close: async () => undefined,
    }));
    const stdout: string[] = [];

    const result = await runDashboard({
      vaultRoot: explicitRoot,
      createServer,
      openBrowser: async () => undefined,
      stdout: (line) => stdout.push(line),
    });

    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      vaultRoot: explicitRoot,
    }));
    expect(stdout).toEqual([
      `Memory dashboard: http://127.0.0.1:4410/memory/`,
      `Vault root: ${explicitRoot}`,
    ]);
    await result.close();
  });

  it("exposes a --root option on the dashboard command", () => {
    const program = new Command();
    registerDashboardCommand(program);

    const command = program.commands.find((candidate) => candidate.name() === "dashboard");

    expect(command?.helpInformation()).toContain("--root <path>");
  });

  it("tries the next port when the requested port is already in use", async () => {
    const createServer = vi.fn(async (opts: ServerOptions): Promise<RunningServer> => {
      if (opts.port === 4410) {
        const error = new Error("listen EADDRINUSE") as NodeJS.ErrnoException;
        error.code = "EADDRINUSE";
        throw error;
      }
      return {
        host: opts.host ?? "127.0.0.1",
        port: opts.port ?? 4411,
        close: async () => undefined,
      };
    });

    const result = await runDashboard({
      createServer,
      openBrowser: async () => undefined,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(result.port).toBe(4411);
    expect(createServer).toHaveBeenCalledTimes(2);
    await result.close();
  });

  it("warns on stderr when falling back from a busy requested port", async () => {
    const createServer = vi.fn(async (opts: ServerOptions): Promise<RunningServer> => {
      if (opts.port === 4410) {
        const error = new Error("listen EADDRINUSE") as NodeJS.ErrnoException;
        error.code = "EADDRINUSE";
        throw error;
      }
      return {
        host: opts.host ?? "127.0.0.1",
        port: opts.port ?? 4411,
        close: async () => undefined,
      };
    });
    const stderr: string[] = [];

    const result = await runDashboard({
      createServer,
      openBrowser: async () => undefined,
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });

    expect(result.port).toBe(4411);
    expect(stderr).toEqual(["Port 4410 busy, using 4411 instead."]);
    await result.close();
  });

  it("does not warn when the requested port succeeds", async () => {
    const createServer = vi.fn(async (opts: ServerOptions): Promise<RunningServer> => ({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 4410,
      close: async () => undefined,
    }));
    const stderr: string[] = [];

    const result = await runDashboard({
      createServer,
      openBrowser: async () => undefined,
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });

    expect(result.port).toBe(4410);
    expect(createServer).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
    await result.close();
  });

  it("does not warn when port 0 resolves to an assigned port", async () => {
    const createServer = vi.fn(async (_opts: ServerOptions): Promise<RunningServer> => ({
      host: "127.0.0.1",
      port: 51234,
      close: async () => undefined,
    }));
    const stderr: string[] = [];

    const result = await runDashboard({
      port: 0,
      createServer,
      openBrowser: async () => undefined,
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });

    expect(result.port).toBe(51234);
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ port: 0 }));
    expect(createServer).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
    await result.close();
  });

  it("builds the dashboard UI once when the dist index is missing", async () => {
    const distRoot = join(tmp, "dist", "dashboard-ui");
    const close = vi.fn(async () => undefined);
    const buildDashboardUi = vi.fn(async () => {
      await mkdir(distRoot, { recursive: true });
      await writeFile(join(distRoot, "index.html"), "<!doctype html>\n");
    });
    const createServer = vi.fn(async (opts: ServerOptions): Promise<RunningServer> => ({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 4410,
      close,
    }));
    const stdout: string[] = [];

    const result = await runDashboard({
      dashboardDistRoot: distRoot,
      buildDashboardUi,
      createServer,
      openBrowser: async () => undefined,
      stdout: (line) => stdout.push(line),
    });

    expect(buildDashboardUi).toHaveBeenCalledOnce();
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      dashboardDistRoot: distRoot,
    }));
    expect(stdout[0]).toBe(`building dashboard UI (${join(distRoot, "index.html")} missing)...`);
    expect(stdout).toContain("Memory dashboard: http://127.0.0.1:4410/memory/");

    await result.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("finds the dashboard source from the module path when cwd is outside the repo", async () => {
    const outsideCwd = join(tmp, "outside");
    const repoRoot = join(tmp, "repo");
    const distRoot = join(repoRoot, "dist", "dashboard-ui");
    await mkdir(outsideCwd, { recursive: true });
    await mkdir(join(repoRoot, "src", "dashboard-ui"), { recursive: true });
    await mkdir(join(repoRoot, "dist"), { recursive: true });
    await writeFile(join(repoRoot, "package.json"), "{}\n");
    await writeFile(join(repoRoot, "vite.config.ts"), "export default {};\n");
    await writeFile(join(repoRoot, "src", "dashboard-ui", "index.html"), "<!doctype html>\n");
    const buildDashboardUi = vi.fn(async ({ repoRoot: buildRepoRoot }) => {
      expect(buildRepoRoot).toBe(repoRoot);
      await mkdir(distRoot, { recursive: true });
      await writeFile(join(distRoot, "index.html"), "<!doctype html>\n");
    });
    const createServer = vi.fn(async (opts: ServerOptions): Promise<RunningServer> => ({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 4410,
      close: async () => undefined,
    }));
    const stdout: string[] = [];
    const originalCwd = process.cwd();
    process.chdir(outsideCwd);
    try {
      const result = await runDashboard({
        dashboardDistRoot: distRoot,
        dashboardModuleUrl: pathToFileURL(join(repoRoot, "dist", "cli.mjs")).href,
        buildDashboardUi,
        createServer,
        openBrowser: async () => undefined,
        stdout: (line) => stdout.push(line),
      });

      expect(buildDashboardUi).toHaveBeenCalledOnce();
      expect(stdout[0]).toBe(`building dashboard UI (${join(distRoot, "index.html")} missing)...`);
      await result.close();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not rebuild when the dashboard dist index is already present", async () => {
    const distRoot = join(tmp, "dist", "dashboard-ui");
    await mkdir(distRoot, { recursive: true });
    await writeFile(join(distRoot, "index.html"), "<!doctype html>\n");
    const buildDashboardUi = vi.fn(async () => undefined);
    const createServer = vi.fn(async (opts: ServerOptions): Promise<RunningServer> => ({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 4410,
      close: async () => undefined,
    }));
    const stdout: string[] = [];

    const result = await runDashboard({
      dashboardDistRoot: distRoot,
      buildDashboardUi,
      createServer,
      openBrowser: async () => undefined,
      stdout: (line) => stdout.push(line),
    });

    expect(buildDashboardUi).not.toHaveBeenCalled();
    expect(stdout).not.toContain(expect.stringContaining("building dashboard UI"));
    await result.close();
  });

  it("surfaces the build:ui hint when the SPA dist is missing", async () => {
    const distRoot = join(tmp, "missing", "dashboard-ui");
    await expect(runDashboard({
      dashboardDistRoot: distRoot,
      dashboardModuleUrl: pathToFileURL(join(tmp, "not-a-real-memory-system", "dist", "cli.mjs")).href,
      createServer: async () => ({
        host: "127.0.0.1",
        port: 4410,
        close: async () => undefined,
      }),
      openBrowser: async () => undefined,
      stdout: () => undefined,
    })).rejects.toThrow(`dashboard UI dist missing index.html at ${join(distRoot, "index.html")}; run \`npm run build:ui\` in`);
  });
});
