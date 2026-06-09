import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateBridgeTlsCert,
  loadBridgeTlsCert,
  removeBridgeTlsCert,
} from "../../src/mcp/tls.js";
import { chatgptBridgeCertDir } from "../../src/storage/paths.js";

describe("TLS cert generation", () => {
  let origAppData: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    origAppData = process.env["APPDATA"];
    tempDir = await mkdtemp(join(tmpdir(), "mf-tls-"));
    process.env["APPDATA"] = tempDir;
  });

  afterEach(async () => {
    if (origAppData === undefined) {
      delete process.env["APPDATA"];
    } else {
      process.env["APPDATA"] = origAppData;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loadBridgeTlsCert returns null when no cert exists", async () => {
    const result = await loadBridgeTlsCert();
    expect(result).toBeNull();
  });

  it("generateBridgeTlsCert creates cert and key files", async () => {
    const cert = await generateBridgeTlsCert();
    expect(cert.cert).toContain("BEGIN CERTIFICATE");
    expect(cert.key).toContain("BEGIN PRIVATE KEY");
    expect(existsSync(join(chatgptBridgeCertDir(), "cert.pem"))).toBe(true);
    expect(existsSync(join(chatgptBridgeCertDir(), "key.pem"))).toBe(true);
  });

  it("loadBridgeTlsCert returns cert after generation", async () => {
    await generateBridgeTlsCert();
    const loaded = await loadBridgeTlsCert();
    expect(loaded).not.toBeNull();
    expect(loaded?.cert).toContain("BEGIN CERTIFICATE");
  });

  it("removeBridgeTlsCert deletes cert directory", async () => {
    await generateBridgeTlsCert();
    await removeBridgeTlsCert();
    const loaded = await loadBridgeTlsCert();
    expect(loaded).toBeNull();
  });
});
