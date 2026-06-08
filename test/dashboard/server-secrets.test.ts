import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/dashboard/server.js";

async function start(overrides: Record<string, unknown> = {}) {
  const vaultRoot = await mkdtemp(join(tmpdir(), "mf-srv-"));
  const server = await createServer({
    vaultRoot,
    host: "127.0.0.1",
    port: 0,
    writeCapability: { writable: true },
    secretsPathImpl: () => join(vaultRoot, "..", "secrets.json"),
    validateKeyImpl: async () => ({ ok: true }),
    ...overrides,
  } as never);
  const origin = `http://127.0.0.1:${server.port}`;
  return { server, origin, base: `${origin}/memory` };
}

describe("/api/secrets", () => {
  it("GET reports presence + last4, never the full key", async () => {
    const { server, base } = await start({
      readSecretsMetaImpl: async () => ({ VOYAGE_API_KEY: { present: true, last4: "wxyz" } }),
    });
    try {
      const res = await fetch(`${base}/api/secrets`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.VOYAGE_API_KEY).toEqual({ present: true, last4: "wxyz" });
    } finally {
      await server.close();
    }
  });

  it("PUT validates then persists; rejects a bad key with 422", async () => {
    const writeSpy = vi.fn(async () => {});
    const { server, origin } = await start({
      validateKeyImpl: async (_p: string, key: string) => ({
        ok: key === "good",
        message: "invalid or unauthorized API key",
      }),
      writeSecretImpl: writeSpy,
    });
    try {
      const ok = await fetch(`${origin}/api/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ provider: "voyage", key: "good" }),
      });
      expect(ok.status).toBe(200);
      expect(writeSpy).toHaveBeenCalledWith("VOYAGE_API_KEY", "good", expect.any(String));

      const bad = await fetch(`${origin}/api/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ provider: "voyage", key: "nope" }),
      });
      expect(bad.status).toBe(422);
    } finally {
      await server.close();
    }
  });

  it("PUT rejects cross-origin requests with 403", async () => {
    const { server, origin } = await start();
    try {
      const res = await fetch(`${origin}/api/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
        body: JSON.stringify({ provider: "voyage", key: "somekey" }),
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("PUT returns 400 for missing provider or empty key", async () => {
    const { server, origin } = await start();
    try {
      const noProvider = await fetch(`${origin}/api/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ key: "somekey" }),
      });
      expect(noProvider.status).toBe(400);

      const noKey = await fetch(`${origin}/api/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ provider: "voyage" }),
      });
      expect(noKey.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
