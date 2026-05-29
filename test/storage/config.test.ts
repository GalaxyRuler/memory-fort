import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemoryConfig, type MemoryConfig } from "../../src/storage/config.js";

describe("memory config reader", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-config-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("loadMemoryConfig returns empty when config.yaml missing", async () => {
    await expect(loadMemoryConfig(tmp)).resolves.toEqual({});
  });

  it("loadMemoryConfig parses provider + vps sections without a config API key slot", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        '  provider: "voyage"',
        '  model: "voyage-4-large"',
        "vps:",
        '  host: "srv1317946"',
        '  install_root: "/root/memory-system"',
      ].join("\n"),
    );

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({
      embedder: { provider: "voyage", model: "voyage-4-large" },
      vps: { host: "srv1317946", install_root: "/root/memory-system" },
    });
  });

  it("loadMemoryConfig parses dashboard trusted origins from block lists", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "dashboard:",
        "  trusted_origins:",
        "    - https://srv1317946.tail6916d8.ts.net",
        "    - http://127.0.0.1:4410",
        "",
      ].join("\n"),
    );

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({
      dashboard: {
        trusted_origins: [
          "https://srv1317946.tail6916d8.ts.net",
          "http://127.0.0.1:4410",
        ],
      },
    });
  });

  it("loadMemoryConfig parses full YAML features with JSON schema dates", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "llm:",
        "  provider: openrouter # inline comment",
        "  model: openai/gpt-4o-mini",
        "  max_tokens: 4096",
        "  temperature: 0.2",
        "  options:",
        "    response_format:",
        "      type: json_object",
        "dashboard:",
        "  trusted_origins: [https://example.test, http://127.0.0.1:4410]",
        "compile:",
        "  scheduled: true",
        "  next_run: 2026-05-29",
      ].join("\n"),
    );

    const config = await loadMemoryConfig(tmp);

    expect(config.llm).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      max_tokens: 4096,
      temperature: 0.2,
      options: {
        response_format: { type: "json_object" },
      },
    });
    expect(config.dashboard?.trusted_origins).toEqual([
      "https://example.test",
      "http://127.0.0.1:4410",
    ]);
    expect(config.compile?.scheduled).toBe(true);
    expect((config.compile as Record<string, unknown>).next_run).toBe("2026-05-29");
  });

  it("loadMemoryConfig surfaces malformed YAML instead of silently defaulting", async () => {
    await writeFile(join(tmp, "config.yaml"), 'voyage:\n  api_key: "unterminated\n');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("config.yaml"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("YAML"));
    await expect(readFile(join(tmp, "errors.log"), "utf-8")).resolves.toContain("config.yaml");
    warn.mockRestore();
  });

  it("loadMemoryConfig warns about invalid known values while preserving the config", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        "  provider: bogus",
        "llm:",
        "  provider: nope",
        "  max_tokens: -1",
        "retention:",
        "  raw_window_days: 30",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadMemoryConfig(tmp)).resolves.toMatchObject({
      embedder: { provider: "bogus" },
      llm: { provider: "nope", max_tokens: -1 },
      retention: { raw_window_days: 30 },
    });
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain("embedder.provider");
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain("llm.max_tokens");
    await expect(readFile(join(tmp, "errors.log"), "utf-8")).resolves.toContain("llm.provider");
    warn.mockRestore();
  });

  it("MemoryConfig types compile.execute", () => {
    const config: MemoryConfig = { compile: { execute: true } };

    expect(config.compile?.execute).toBe(true);
  });
});
