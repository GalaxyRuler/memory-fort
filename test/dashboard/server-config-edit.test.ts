import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/dashboard/server.js";
import { READ_ONLY_MIRROR_REASON } from "../../src/sync/vault-capability.js";

describe("dashboard server config editing routes", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "dash-config-edit-"));
    await mkdir(join(tmp, ".git"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await writeFile(
      join(tmp, "config.yaml"),
      ["embedder:", "  provider: voyage", "  model: voyage-4-large", ""].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("GET /api/providers returns provider catalog JSON", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });
    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/providers`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.embedders.map((item: { provider: string }) => item.provider)).toContain("voyage");
      expect(body.llms.map((item: { provider: string }) => item.provider)).toContain("openrouter");
    } finally {
      await server.close();
    }
  });

  it("PATCH /api/config applies safelisted fields", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });
    try {
      const origin = `http://${server.host}:${server.port}`;
      const response = await fetch(`${origin}/api/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ embedder: { provider: "openai", model: "text-embedding-3-small" } }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true, applied: ["embedder.provider", "embedder.model"] });
      await expect(readFile(join(tmp, "config.yaml"), "utf-8")).resolves.toContain("provider: openai");
    } finally {
      await server.close();
    }
  });

  it("PATCH /api/config rejects unsafelisted fields and cross-origin requests", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });
    try {
      const origin = `http://${server.host}:${server.port}`;
      const badField = await fetch(`${origin}/api/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ embedder: { api_key: "secret" } }),
      });
      expect(badField.status).toBe(400);
      await expect(badField.json()).resolves.toEqual({
        ok: false,
        errors: [{ path: "embedder.api_key", message: "field not in safelist" }],
      });

      const crossOrigin = await fetch(`${origin}/api/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
        body: JSON.stringify({ embedder: { provider: "openai" } }),
      });
      expect(crossOrigin.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("PATCH /api/config refuses writes on a read-only mirror", async () => {
    await rm(join(tmp, ".git"), { recursive: true, force: true });
    const server = await createServer({ vaultRoot: tmp, port: 0 });
    try {
      const origin = `http://${server.host}:${server.port}`;
      const response = await fetch(`${origin}/api/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ embedder: { provider: "openai" } }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ ok: false, error: READ_ONLY_MIRROR_REASON });
    } finally {
      await server.close();
    }
  });
});
