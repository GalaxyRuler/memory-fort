import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { isClientEnabled, loadMemoryConfig, type MemoryConfig, validateMemoryConfig } from "../../src/storage/config.js";

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
        '  host: "examplehost"',
        '  install_root: "/root/memory-system"',
      ].join("\n"),
    );

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({
      embedder: { provider: "voyage", model: "voyage-4-large" },
      vps: { host: "examplehost", install_root: "/root/memory-system" },
    });
  });

  it("checked-in config template seeds keyless lexical retrieval", async () => {
    const template = yaml.load(await readFile(join(process.cwd(), "templates", "config.yaml"), "utf-8"));

    expect(template).toMatchObject({
      embedder: { provider: "lexical", model: "lexical" },
      embedding: { provider: "lexical", model: "lexical", dim: 0 },
    });
  });

  it("loadMemoryConfig parses dashboard URL, trusted origins, and sync remote", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "sync:",
        "  remote_name: mirror",
        "dashboard:",
        "  url: https://mirror.example/memory",
        "  trusted_origins:",
        "    - https://examplehost.exampletail.ts.net",
        "    - http://127.0.0.1:4410",
        "",
      ].join("\n"),
    );

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({
      sync: { remote_name: "mirror" },
      dashboard: {
        url: "https://mirror.example/memory",
        trusted_origins: [
          "https://examplehost.exampletail.ts.net",
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
        exempt_hub_pages: ["wiki/references/mcp-servers-available.md"],
      },
    };

    expect(config.auto_link?.title_threshold).toBe(0.6);
    expect(config.auto_link?.mass_collision_threshold).toBe(0.2);
    expect(config.auto_link?.exempt_hub_pages).toEqual(["wiki/references/mcp-servers-available.md"]);
  });

  it("loadMemoryConfig warns when auto-link hub exemptions are not path strings", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "auto_link:",
        "  exempt_hub_pages:",
        "    - wiki/references/mcp-servers-available.md",
        "    - 42",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadMemoryConfig(tmp)).resolves.toMatchObject({
      auto_link: {
        exempt_hub_pages: ["wiki/references/mcp-servers-available.md", 42],
      },
    });
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain("auto_link.exempt_hub_pages");
    warn.mockRestore();
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

  it("uses an explicit raw retention action and warns that superseded retention booleans do nothing", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "retention:",
        "  raw_window_days: 30",
        "  raw_action: archive",
        "  raw_compile_before_delete: true",
        "  embeddings_prune_with_raw: true",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadMemoryConfig(tmp)).resolves.toMatchObject({
      retention: { raw_window_days: 30, raw_action: "archive" },
    });
    const warnings = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warnings).toContain("retention.raw_compile_before_delete is deprecated");
    expect(warnings).toContain("retention.embeddings_prune_with_raw is deprecated");
    expect(validateMemoryConfig({ retention: { raw_action: "delete" as never } })).toContain(
      "retention.raw_action must be archive; delete retention is not implemented",
    );
    warn.mockRestore();
  });

  it("appends a given deprecated-config warning only once per process", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "retention:",
        "  archive_before_delete: true",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await loadMemoryConfig(tmp);
    await loadMemoryConfig(tmp);

    const lines = (await readFile(join(tmp, "errors.log"), "utf-8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("retention.archive_before_delete is deprecated");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("atomically bounds an oversized errors.log to its recent tail", async () => {
    const errorsPath = join(tmp, "errors.log");
    await writeFile(errorsPath, "oversized-fixture-line\n".repeat(300_000));
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        "  provider: oversized-fixture-provider",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await loadMemoryConfig(tmp);

    const content = await readFile(errorsPath, "utf-8");
    expect(Buffer.byteLength(content, "utf-8")).toBeLessThan(1_100_000);
    expect(content.startsWith("[")).toBe(true);
    expect(content).toContain("errors.log truncated after exceeding 5 MB");
    expect(content).toContain("oversized-fixture-provider");
    warn.mockRestore();
  });
});

describe("client toggles", () => {
  it("defaults to enabled when clients map or key is absent", () => {
    expect(isClientEnabled({}, "codex")).toBe(true);
    expect(isClientEnabled({ clients: {} }, "codex")).toBe(true);
  });

  it("defaults ChatGPT to disabled until explicitly enabled", () => {
    expect(isClientEnabled({}, "chatgpt")).toBe(false);
    expect(isClientEnabled({ clients: {} }, "chatgpt")).toBe(false);
    expect(isClientEnabled({ clients: { chatgpt: true } }, "chatgpt")).toBe(true);
  });

  it("honors an explicit false", () => {
    expect(isClientEnabled({ clients: { codex: false } }, "codex")).toBe(false);
    expect(isClientEnabled({ clients: { codex: false } }, "claude-code")).toBe(true);
  });

  it("warns when a client flag is not a boolean", () => {
    const warnings = validateMemoryConfig({ clients: { codex: "nope" } } as never);
    expect(warnings.some((w) => w.includes("clients.codex"))).toBe(true);
  });
});
