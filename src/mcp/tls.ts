import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { chatgptBridgeCertDir } from "../storage/paths.js";

const execFileAsync = promisify(execFile);

export interface TlsCert {
  cert: string;
  key: string;
}

/**
 * Load existing cert+key from disk, or return null if not generated yet.
 */
export async function loadBridgeTlsCert(): Promise<TlsCert | null> {
  const dir = chatgptBridgeCertDir();
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;
  const [cert, key] = await Promise.all([
    readFile(certPath, "utf-8"),
    readFile(keyPath, "utf-8"),
  ]);
  return { cert, key };
}

/**
 * Generate a self-signed cert for localhost/127.0.0.1 using openssl CLI.
 * Stores cert.pem and key.pem in chatgptBridgeCertDir().
 * Returns the generated cert+key.
 */
export async function generateBridgeTlsCert(): Promise<TlsCert> {
  const dir = chatgptBridgeCertDir();
  await mkdir(dir, { recursive: true });
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");

  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "3650",
    "-nodes",
    "-subj", "/CN=Memory Fort Bridge",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);

  const [cert, key] = await Promise.all([
    readFile(certPath, "utf-8"),
    readFile(keyPath, "utf-8"),
  ]);
  return { cert, key };
}

/**
 * Add the bridge cert to the OS trust store so ChatGPT desktop (Chromium) trusts it.
 */
export async function trustBridgeCert(): Promise<{ trusted: boolean; message: string }> {
  const certPath = join(chatgptBridgeCertDir(), "cert.pem");
  if (!existsSync(certPath)) {
    return { trusted: false, message: "cert.pem not found - run generate first" };
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("certutil", ["-addstore", "-user", "Root", certPath]);
      return { trusted: true, message: "Added cert to Windows user trusted root store" };
    } catch (err) {
      return { trusted: false, message: `certutil failed: ${(err as Error).message}` };
    }
  }

  if (process.platform === "darwin") {
    try {
      const keychainPath = join(process.env["HOME"] ?? "", "Library", "Keychains", "login.keychain-db");
      await execFileAsync("security", [
        "add-trusted-cert", "-r", "trustRoot", "-k", keychainPath, certPath,
      ]);
      return { trusted: true, message: "Added cert to macOS login keychain" };
    } catch (err) {
      return { trusted: false, message: `security add-trusted-cert failed: ${(err as Error).message}` };
    }
  }

  return {
    trusted: false,
    message: `Manually trust ${certPath} in your OS certificate store`,
  };
}

/**
 * Remove the bridge cert from the OS trust store.
 */
export async function untrustBridgeCert(): Promise<void> {
  if (process.platform === "win32") {
    try {
      await execFileAsync("certutil", ["-delstore", "-user", "Root", "Memory Fort Bridge"]);
    } catch {
      // Cert may not be in store.
    }
  }

  if (process.platform === "darwin") {
    try {
      await execFileAsync("security", [
        "delete-certificate", "-c", "Memory Fort Bridge",
      ]);
    } catch {
      // Cert may not be in keychain.
    }
  }
}

/**
 * Remove cert files from disk.
 */
export async function removeBridgeTlsCert(): Promise<void> {
  const { rm } = await import("node:fs/promises");
  const dir = chatgptBridgeCertDir();
  await rm(dir, { recursive: true, force: true });
}
