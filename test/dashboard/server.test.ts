import { describe, expect, it } from "vitest";
import type { DashboardStatus } from "../../src/dashboard/loaders.js";
import { createServer } from "../../src/dashboard/server.js";

function fixture(): DashboardStatus {
  return {
    vaultRoot: "/root/memory-system/vault",
    repoHead: {
      sha: "abcdef1234567890",
      shortSha: "abcdef1",
      subject: "curated memory update",
      committedAt: "2026-05-23T01:00:00.000Z",
    },
    counts: { wikiPages: 12, rawObservations: 19, crystals: 0 },
    lastCompile: null,
    errorsLog: { sizeBytes: 0, lastLine: null, isClean: true },
    syncState: null,
    generatedAt: "2026-05-23T01:10:00.000Z",
  };
}

describe("dashboard server", () => {
  it("GET /healthz returns 200 text/plain ok", async () => {
    let loaderCalled = false;
    const server = await createServer({
      vaultRoot: "/unused",
      port: 0,
      loader: async () => {
        loaderCalled = true;
        return fixture();
      },
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/healthz`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      await expect(response.text()).resolves.toBe("ok");
      expect(loaderCalled).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("GET / returns 200 HTML with the loader's data rendered", async () => {
    const server = await createServer({
      vaultRoot: "/unused",
      port: 0,
      loader: async () => fixture(),
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      await expect(response.text()).resolves.toContain("abcdef1234567890");
    } finally {
      await server.close();
    }
  });

  it("GET /api/status returns 200 JSON matching the loader output", async () => {
    const status = fixture();
    const server = await createServer({
      vaultRoot: "/unused",
      port: 0,
      loader: async () => status,
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/status`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual(status);
    } finally {
      await server.close();
    }
  });
});
