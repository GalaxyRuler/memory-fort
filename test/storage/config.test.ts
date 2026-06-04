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

  it("loadMemoryConfig parses dashboard URL, trusted origins, and sync remote", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "sync:",
        "  remote_name: whitedragon",
        "dashboard:",
        "  url: https://whitedragon.example/memory",
        "  trusted_origins:",
        "    - https://srv1317946.tail6916d8.ts.net",
        "    - http://127.0.0.1:4410",
        "",
      ].join("\n"),
    );

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({
      sync: { remote_name: "whitedragon" },
      dashboard: {
        url: "https://whitedragon.example/memory",
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

  it("MemoryConfig types capture byte caps", () => {
    const config: MemoryConfig = {
      capture: { max_input_bytes: 8192, max_output_bytes: 8192 },
    };

    expect(config.capture?.max_input_bytes).toBe(8192);
    expect(config.capture?.max_output_bytes).toBe(8192);
  });

  it("MemoryConfig types auto-link safety thresholds", () => {
    const config: MemoryConfig = {
      auto_link: {
        enabled: true,
        similarity_threshold: 0.75,
        title_threshold: 0.6,
        mass_collision_threshold: 0.2,
      },
    };

    expect(config.auto_link?.title_threshold).toBe(0.6);
    expect(config.auto_link?.mass_collision_threshold).toBe(0.2);
  });

  it("MemoryConfig types auto-heal budget and tick caps", () => {
    const config: MemoryConfig = {
      auto_heal: {
        enabled: true,
        daily_budget_usd: 0.5,
        max_docs_per_tick: 25,
        max_tokens_per_tick: 50_000,
        tick_interval_seconds: 300,
      },
    };

    expect(config.auto_heal?.enabled).toBe(true);
    expect(config.auto_heal?.daily_budget_usd).toBe(0.5);
  });

  it("MemoryConfig types compressor coverage caps", () => {
    const config: MemoryConfig = {
      compress: {
        max_input_bytes: 48_000,
        chunk_threshold_bytes: 48_000,
        max_chunks: 8,
        max_call_tokens: 100_000,
      },
    };

    expect(config.compress?.max_input_bytes).toBe(48_000);
    expect(config.compress?.chunk_threshold_bytes).toBe(48_000);
    expect(config.compress?.max_chunks).toBe(8);
    expect(config.compress?.max_call_tokens).toBe(100_000);
  });
});
