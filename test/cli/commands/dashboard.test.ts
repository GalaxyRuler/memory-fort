import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    });

    expect(result.port).toBe(4411);
    expect(createServer).toHaveBeenCalledTimes(2);
    await result.close();
  });

  it("surfaces the build:ui hint when the SPA dist is missing", async () => {
    await expect(runDashboard({
      createServer: async () => {
        throw new Error("dashboard UI dist missing index.html at C:/x/dist/dashboard-ui/index.html; run `npm run build:ui` first");
      },
      openBrowser: async () => undefined,
      stdout: () => undefined,
    })).rejects.toThrow("run `npm run build:ui` first");
  });
});
