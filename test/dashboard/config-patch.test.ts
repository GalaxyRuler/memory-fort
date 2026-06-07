import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigPatch,
  validateConfigPatch,
} from "../../src/dashboard/config-patch.js";
import { loadMemoryConfig } from "../../src/storage/config.js";

describe("dashboard config patch", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "config-patch-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        "  provider: voyage",
        "  model: voyage-4-large",
        "llm:",
        "  provider: ollama",
        "  model: llama3.2",
        "  max_tokens: 2048",
        "  temperature: 0.4",
        "retention:",
        "  raw_window_days: 90",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("accepts safelisted embedder and llm fields", () => {
    expect(validateConfigPatch({
      embedder: { provider: "openai", model: "text-embedding-3-small", options: {} },
      llm: { provider: "openrouter", model: "openai/gpt-4o-mini", max_tokens: 4096, temperature: 0.2 },
      auto_promote: { enabled: true, cadence: "weekly", confidence_threshold: "high" },
      compile: { scheduled: true, cadence: "daily", execute: true },
      dashboard: { trusted_origins: ["https://examplehost.exampletail.ts.net"] },
    })).toEqual({ ok: true, errors: [] });
  });

  it("rejects unsafelisted fields with the offending path", () => {
    const result = validateConfigPatch({ embedder: { api_key: "secret" } });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      path: "embedder.api_key",
      message: "field not in safelist",
    });
  });

  it("rejects invalid provider and tuning values", () => {
    const result = validateConfigPatch({
      embedder: { provider: "bad" },
      llm: { max_tokens: 99999, temperature: 3 },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "embedder.provider" }),
        expect.objectContaining({ path: "llm.max_tokens" }),
        expect.objectContaining({ path: "llm.temperature" }),
      ]),
    );
  });

  it("rejects secret-like keys inside safelisted options objects", () => {
    const result = validateConfigPatch({
      embedder: { options: { api_key: "secret" } },
      llm: { options: { token: "secret" } },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { path: "embedder.options.api_key", message: "API keys and secrets are env-var-only" },
        { path: "llm.options.token", message: "API keys and secrets are env-var-only" },
      ]),
    );
  });

  it("rejects internal, loopback, and metadata embedder hosts (SSRF / OWASP API7)", () => {
    const metadata = validateConfigPatch({
      embedder: { provider: "openai", options: { baseURL: "http://169.254.169.254/latest/meta-data/" } },
    });
    expect(metadata.ok).toBe(false);
    expect(metadata.errors).toContainEqual(
      expect.objectContaining({ path: "embedder.options.baseURL" }),
    );

    const loopback = validateConfigPatch({
      embedder: { provider: "ollama", options: { host: "http://127.0.0.1:11434" } },
    });
    expect(loopback.ok).toBe(false);
    expect(loopback.errors).toContainEqual(
      expect.objectContaining({ path: "embedder.options.host" }),
    );

    const privateRange = validateConfigPatch({
      llm: { options: { baseURL: "http://192.168.1.10:8080/v1" } },
    });
    expect(privateRange.ok).toBe(false);
    expect(privateRange.errors).toContainEqual(
      expect.objectContaining({ path: "llm.options.baseURL" }),
    );
  });

  it("normalizes root-dot hostnames before internal host checks", () => {
    for (const value of [
      "http://localhost.:11434",
      "http://127.0.0.1.:11434",
    ]) {
      const result = validateConfigPatch({
        llm: { provider: "ollama", options: { host: value } },
      });
      expect(result.ok, value).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: "llm.options.host" }),
      );
    }
  });

  it("rejects IPv4-mapped and internal IPv6 outbound hosts", () => {
    for (const value of [
      "http://[::ffff:127.0.0.1]:11434",
      "http://[::ffff:10.0.0.1]:11434",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[2001:db8:0808:0808::]:11434",
      "http://[fe90::1]:11434",
      "http://[febf::1]:11434",
    ]) {
      const result = validateConfigPatch({
        embedder: { options: { baseURL: value } },
      });
      expect(result.ok, value).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: "embedder.options.baseURL" }),
      );
    }
  });

  it("rejects non-global public IP literals in configured outbound hosts without opt-in", () => {
    for (const value of [
      "http://198.18.0.1:11434",
      "http://192.88.99.1:11434",
      "http://192.0.2.1:11434",
      "http://198.51.100.1:11434",
      "http://203.0.113.1:11434",
      "http://224.0.0.1:11434",
      "http://255.255.255.255:11434",
      "http://[64:ff9b::a9fe:a9fe]:11434",
      "http://[64:ff9b:1::a9fe:a9fe]:11434",
      "http://[2001:4860:0a00:0001::]:11434",
      "http://[4000::808:808]:11434",
      "http://[::2]:11434",
      "http://[::127.0.0.1]:11434",
      "http://[::192.168.0.1]:11434",
      "http://[100::1]:11434",
      "http://[100:0:0:1::1]:11434",
      "http://[2001:2::1]:11434",
      "http://[2001:db8::1]:11434",
      "http://[2002::1]:11434",
      "http://[3fff::1]:11434",
      "http://[4000::1]:11434",
      "http://[5f00::1]:11434",
      "http://[8000::808:808]:11434",
      "http://[8000::1]:11434",
      "http://[ff00::1]:11434",
      "http://[fec0::1]:11434",
    ]) {
      const result = validateConfigPatch({
        embedder: { provider: "ollama", options: { host: value } },
      });
      expect(result.ok, value).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: "embedder.options.host" }),
      );
    }
  });

  it("rejects RFC 6052 /96 NSPs embedding non-global IPv4 literals", () => {
    for (const value of [
      "http://[2001:4860::7f00:1]:11434",
      "http://[2001:4860::127.0.0.1]:11434",
      "http://[2001:4860::a00:1]:11434",
      "http://[2001:4860::10.0.0.1]:11434",
      "http://[2001:4860::a9fe:a9fe]:11434",
      "http://[2001:4860::169.254.169.254]:11434",
    ]) {
      const result = validateConfigPatch({
        embedder: { provider: "ollama", options: { host: value } },
      });
      expect(result.ok, value).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: "embedder.options.host" }),
      );
    }
  });

  it("rejects non-http(s) schemes in outbound URL options", () => {
    for (const value of ["file:/etc/passwd", "file:///etc/passwd", "data:", "mailto:root@example.test", "http:example.com"]) {
      const result = validateConfigPatch({
        embedder: { provider: "openai", options: { baseURL: value } },
      });
      expect(result.ok, value).toBe(false);
      expect(result.errors).toContainEqual({
        path: "embedder.options.baseURL",
        message: "must be an http(s) URL",
      });
    }
  });

  it("allows public outbound hosts without opt-in", () => {
    expect(
      validateConfigPatch({
        embedder: { provider: "openai", options: { baseURL: "https://api.openai.com/v1" } },
      }),
    ).toEqual({ ok: true, errors: [] });

    for (const host of [
      "http://8.8.8.8:11434",
      "http://192.0.0.9:11434",
      "http://192.0.0.10:11434",
      "http://[64:ff9b::808:808]:11434",
      "http://[2001:4860::808:808]:11434",
      "http://[2001:4860::]:11434",
      "http://[2001:4860:0808:0808::]:11434",
      "http://[2001:4860:0a00:0001:0100::]:11434",
    ]) {
      expect(
        validateConfigPatch({
          embedder: { provider: "ollama", options: { host } },
        }),
      ).toEqual({ ok: true, errors: [] });
    }
  });

  it("requires OpenAI embedder baseURL to use the official HTTPS endpoint", () => {
    for (const baseURL of [
      "http://api.openai.com/v1",
      "https://8.8.8.8/v1",
      "http://8.8.8.8/v1",
      "https://api.openai.com",
      "https://api.openai.com:444/v1",
      "https://user:pass@api.openai.com/v1",
      "https://api.openai.com/v1?x=1",
      "https://api.openai.com/v1#x",
    ]) {
      const result = validateConfigPatch({
        embedder: { provider: "openai", options: { baseURL } },
      });
      expect(result.ok, baseURL).toBe(false);
      expect(result.errors).toContainEqual({
        path: "embedder.options.baseURL",
        message: "must use the official OpenAI HTTPS endpoint",
      });
    }

    expect(
      validateConfigPatch({
        embedder: { provider: "openai", options: { baseURL: "https://api.openai.com/v1" } },
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(
      validateConfigPatch({
        embedder: { provider: "openai", options: { baseURL: "https://api.openai.com/v1/" } },
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("rejects non-official DNS hostnames in configured outbound URLs before runtime", () => {
    for (const patch of [
      { embedder: { provider: "ollama", options: { host: "http://ollama.example.test:11434" } } },
      { llm: { provider: "ollama", options: { host: "http://ollama.example.test:11434" } } },
      { embedder: { provider: "ollama", options: { host: "https://api.openai.com" } } },
      { embedder: { provider: "ollama", options: { host: "https://api.voyageai.com" } } },
      { embedder: { provider: "ollama", options: { host: "https://openrouter.ai" } } },
      { llm: { provider: "ollama", options: { host: "https://api.openai.com" } } },
      { llm: { provider: "ollama", options: { host: "https://api.voyageai.com" } } },
      { llm: { provider: "ollama", options: { host: "https://openrouter.ai" } } },
    ]) {
      const result = validateConfigPatch(patch);
      expect(result.ok, JSON.stringify(patch)).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("DNS hostnames are blocked"),
        }),
      );
    }
  });

  it("allows an embedder internal host only when embedder allow_internal_hosts is opted in", () => {
    expect(
      validateConfigPatch({
        embedder: {
          provider: "ollama",
          allow_internal_hosts: true,
          options: { host: "http://127.0.0.1:11434" },
        },
      }),
    ).toEqual({ ok: true, errors: [] });

    // Opt-in supplied by the caller (e.g. read from current config).
    expect(
      validateConfigPatch(
        { embedder: { provider: "ollama", options: { host: "http://localhost:11434" } } },
        { allowInternalHosts: { embedder: true } },
      ),
    ).toEqual({ ok: true, errors: [] });
  });

  it("allows bare local host ports only with section-scoped internal-host opt-in", () => {
    for (const host of ["localhost:11434", "ollama:11434", "127.0.0.1:11434"]) {
      expect(
        validateConfigPatch({
          embedder: {
            provider: "ollama",
            allow_internal_hosts: true,
            options: { host },
          },
        }),
        host,
      ).toEqual({ ok: true, errors: [] });

      const noOptIn = validateConfigPatch({
        embedder: { provider: "ollama", options: { host } },
      });
      expect(noOptIn.ok, host).toBe(false);
      expect(noOptIn.errors).toContainEqual(
        expect.objectContaining({ path: "embedder.options.host" }),
      );

      const wrongSectionOptIn = validateConfigPatch({
        llm: { allow_internal_hosts: true },
        embedder: { provider: "ollama", options: { host } },
      });
      expect(wrongSectionOptIn.ok, host).toBe(false);
      expect(wrongSectionOptIn.errors).toContainEqual(
        expect.objectContaining({ path: "embedder.options.host" }),
      );
    }

    const schemeLike = validateConfigPatch({
      embedder: {
        provider: "ollama",
        allow_internal_hosts: true,
        options: { host: "ftp:80" },
      },
    });
    expect(schemeLike.ok).toBe(false);
    expect(schemeLike.errors).toContainEqual({
      path: "embedder.options.host",
      message: "must be an http(s) URL",
    });
  });

  it("rejects userinfo in generic configured outbound URLs even with internal-host opt-in", () => {
    for (const patch of [
      {
        embedder: {
          provider: "ollama",
          allow_internal_hosts: true,
          options: { host: "http://user:pass@localhost:11434" },
        },
      },
      {
        llm: {
          provider: "ollama",
          allow_internal_hosts: true,
          options: { host: "http://user:pass@127.0.0.1:11434" },
        },
      },
      {
        llm: {
          provider: "ollama",
          options: { endpoint: "http://user:pass@8.8.8.8:11434" },
        },
      },
    ]) {
      const result = validateConfigPatch(patch);
      expect(result.ok, JSON.stringify(patch)).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: "must be an http(s) URL",
        }),
      );
    }
  });

  it("rejects query and fragment parts in configured Ollama hosts", () => {
    for (const patch of [
      {
        embedder: {
          provider: "ollama",
          allow_internal_hosts: true,
          options: { host: "http://127.0.0.1:11434/?x=1" },
        },
      },
      {
        embedder: {
          provider: "ollama",
          allow_internal_hosts: true,
          options: { host: "http://127.0.0.1:11434/#x" },
        },
      },
      {
        llm: {
          provider: "ollama",
          allow_internal_hosts: true,
          options: { host: "http://127.0.0.1:11434/?x=1" },
        },
      },
      {
        llm: {
          provider: "ollama",
          allow_internal_hosts: true,
          options: { host: "http://127.0.0.1:11434/#x" },
        },
      },
    ]) {
      const result = validateConfigPatch(patch);
      expect(result.ok, JSON.stringify(patch)).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: "must be an http(s) URL",
        }),
      );
    }
  });

  it("keeps embedder and llm internal-host opt-ins section-scoped", () => {
    const llmOptInDoesNotPermitEmbedder = validateConfigPatch({
      llm: { allow_internal_hosts: true },
      embedder: { options: { baseURL: "http://127.0.0.1:11434" } },
    });
    expect(llmOptInDoesNotPermitEmbedder.ok).toBe(false);
    expect(llmOptInDoesNotPermitEmbedder.errors).toContainEqual(
      expect.objectContaining({ path: "embedder.options.baseURL" }),
    );

    const embedderOptInDoesNotPermitLlm = validateConfigPatch({
      embedder: { allow_internal_hosts: true },
      llm: { options: { host: "http://127.0.0.1:11434" } },
    });
    expect(embedderOptInDoesNotPermitLlm.ok).toBe(false);
    expect(embedderOptInDoesNotPermitLlm.errors).toContainEqual(
      expect.objectContaining({ path: "llm.options.host" }),
    );
  });

  it("applyConfigPatch blocks an internal embedder host but honors the persisted opt-in", async () => {
    await expect(
      applyConfigPatch(tmp, { embedder: { options: { host: "http://10.0.0.5:11434" } } }),
    ).rejects.toMatchObject({ name: "ConfigPatchError" });

    // With the opt-in already in config, the same patch is accepted.
    await writeFile(
      join(tmp, "config.yaml"),
      ["embedder:", "  provider: ollama", "  allow_internal_hosts: true", ""].join("\n"),
    );
    const result = await applyConfigPatch(tmp, {
      embedder: { options: { host: "http://10.0.0.5:11434" } },
    });
    expect(result.applied).toContain("embedder.options");
  });

  it("applyConfigPatch does not let llm allow_internal_hosts permit embedder internal hosts", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      ["llm:", "  provider: ollama", "  allow_internal_hosts: true", ""].join("\n"),
    );

    await expect(
      applyConfigPatch(tmp, { embedder: { options: { host: "http://10.0.0.5:11434" } } }),
    ).rejects.toMatchObject({ name: "ConfigPatchError" });
  });

  it("applyConfigPatch rejects disabling embedder internal hosts while setting an internal host", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      ["embedder:", "  provider: ollama", "  allow_internal_hosts: true", ""].join("\n"),
    );

    await expect(
      applyConfigPatch(tmp, {
        embedder: {
          allow_internal_hosts: false,
          options: { host: "http://127.0.0.1:11434" },
        },
      }),
    ).rejects.toMatchObject({ name: "ConfigPatchError" });
  });

  it("applyConfigPatch rejects disabling embedder internal hosts while retaining an existing internal host", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        "  provider: ollama",
        "  allow_internal_hosts: true",
        "  options:",
        "    host: http://127.0.0.1:11434",
        "",
      ].join("\n"),
    );

    await expect(
      applyConfigPatch(tmp, { embedder: { allow_internal_hosts: false } }),
    ).rejects.toMatchObject({ name: "ConfigPatchError" });
  });

  it("applyConfigPatch rejects disabling llm internal hosts while setting an internal host", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      ["llm:", "  provider: ollama", "  allow_internal_hosts: true", ""].join("\n"),
    );

    await expect(
      applyConfigPatch(tmp, {
        llm: {
          allow_internal_hosts: false,
          options: { host: "http://127.0.0.1:11434" },
        },
      }),
    ).rejects.toMatchObject({ name: "ConfigPatchError" });
  });

  it("applyConfigPatch rejects disabling llm internal hosts while retaining an existing internal host", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "llm:",
        "  provider: ollama",
        "  allow_internal_hosts: true",
        "  options:",
        "    host: http://127.0.0.1:11434",
        "",
      ].join("\n"),
    );

    await expect(
      applyConfigPatch(tmp, { llm: { allow_internal_hosts: false } }),
    ).rejects.toMatchObject({ name: "ConfigPatchError" });
  });

  it("applyConfigPatch rejects unrelated patches when existing outbound config is unsafe", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        "  provider: ollama",
        "  options:",
        "    host: http://127.0.0.1:11434",
        "",
      ].join("\n"),
    );

    await expect(
      applyConfigPatch(tmp, { llm: { temperature: 0.3 } }),
    ).rejects.toMatchObject({
      name: "ConfigPatchError",
      errors: expect.arrayContaining([
        expect.objectContaining({ path: "embedder.options.host" }),
      ]),
    });
  });

  it("applyConfigPatch validates option-only OpenAI baseURL patches against the merged provider", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        "  provider: openai",
        "  model: text-embedding-3-small",
        "",
      ].join("\n"),
    );

    await expect(
      applyConfigPatch(tmp, {
        embedder: { options: { baseURL: "https://api.openai.com/v1" } },
      }),
    ).resolves.toMatchObject({ applied: ["embedder.options"] });

    for (const baseURL of [
      "https://8.8.8.8/v1",
      "https://openai.example.test/v1",
      "https://api.openai.com",
      "https://api.openai.com:444/v1",
      "https://user:pass@api.openai.com/v1",
      "https://api.openai.com/v1?x=1",
      "https://api.openai.com/v1#x",
    ]) {
      await expect(
        applyConfigPatch(tmp, { embedder: { options: { baseURL } } }),
      ).rejects.toMatchObject({
        name: "ConfigPatchError",
        errors: expect.arrayContaining([
          {
            path: "embedder.options.baseURL",
            message: "must use the official OpenAI HTTPS endpoint",
          },
        ]),
      });
    }
  });

  it("deep-merges safelisted patches, writes a backup, and keeps config readable", async () => {
    const result = await applyConfigPatch(tmp, {
      embedder: { provider: "openai", model: "text-embedding-3-small", options: { baseURL: "https://api.openai.com/v1" } },
      llm: { model: "anthropic/claude-3.5-sonnet", temperature: 0.1 },
      dashboard: { trusted_origins: ["https://examplehost.exampletail.ts.net"] },
    });

    expect(result.applied).toEqual([
      "embedder.provider",
      "embedder.model",
      "embedder.options",
      "llm.model",
      "llm.temperature",
      "dashboard.trusted_origins",
    ]);
    await expect(loadMemoryConfig(tmp)).resolves.toMatchObject({
      embedder: {
        provider: "openai",
        model: "text-embedding-3-small",
        options: { baseURL: "https://api.openai.com/v1" },
      },
      llm: {
        provider: "ollama",
        model: "anthropic/claude-3.5-sonnet",
        max_tokens: 2048,
        temperature: 0.1,
      },
      dashboard: {
        trusted_origins: ["https://examplehost.exampletail.ts.net"],
      },
      retention: { raw_window_days: 90 },
    });
    const backups = await readdir(join(tmp, ".config-backups"));
    expect(backups).toHaveLength(1);
    await expect(readFile(join(tmp, ".config-backups", backups[0]!), "utf-8")).resolves.toContain("provider: voyage");
  });

  it("leaves the original config intact when the atomic write fails", async () => {
    const original = await readFile(join(tmp, "config.yaml"), "utf-8");

    await expect(applyConfigPatch(tmp, { embedder: { provider: "openai" } }, {
      atomicWrite: async () => {
        throw new Error("disk full");
      },
    })).rejects.toThrow("failed to write config.yaml: disk full");

    await expect(readFile(join(tmp, "config.yaml"), "utf-8")).resolves.toBe(original);
  });

  it("retains only the five newest backups", async () => {
    for (let index = 0; index < 6; index += 1) {
      await applyConfigPatch(tmp, { llm: { max_tokens: 1000 + index } }, {
        now: () => new Date(`2026-05-28T00:00:0${index}.000Z`),
      });
    }

    const backups = (await readdir(join(tmp, ".config-backups"))).sort();
    expect(backups).toHaveLength(5);
    expect(backups[0]).toContain("2026-05-28T00-00-01");
    expect(backups.at(-1)).toContain("2026-05-28T00-00-05");
  });
});
