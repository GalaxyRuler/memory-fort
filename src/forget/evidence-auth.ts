import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const EVIDENCE_KEY_FILE = "evidence-hmac-v1.key";
const EVIDENCE_KEY_BYTES = 32;

export const EVIDENCE_AUTH_ALGORITHM = "HMAC-SHA256" as const;
export const EVIDENCE_KEY_LIMITATION =
  "Signed evidence can be verified only on a device that retains the same device-local evidence key.";

export interface EvidenceAuth {
  readonly algorithm: typeof EVIDENCE_AUTH_ALGORITHM;
  readonly keyId: string;
  readonly signature: string;
}

export type SignedEvidence<T extends object> = T & { readonly auth: EvidenceAuth };
export interface EvidenceSigner {
  readonly keyId: string;
  readonly sign: <T extends object>(payload: T) => Promise<SignedEvidence<T>>;
}

export type EvidenceSignerFactory = (securityDir?: string) => Promise<EvidenceSigner>;

export function resolveEvidenceSecurityDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const overridden = process.env["MEMORY_EVIDENCE_SECURITY_DIR"];
  if (overridden) return resolve(overridden);
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "memory-fort", "evidence-auth");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "memory-fort", "evidence-auth");
  }
  const configRoot = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(configRoot, "memory-fort", "evidence-auth");
}

export async function ensureEvidenceSigningKey(securityDir?: string): Promise<void> {
  await loadEvidenceKey(resolveEvidenceSecurityDir(securityDir), true, "signed evidence");
}

export async function createEvidenceSigner(
  securityDir?: string,
): Promise<EvidenceSigner> {
  const key = await loadEvidenceKey(resolveEvidenceSecurityDir(securityDir), true, "signed evidence");
  const keyId = evidenceKeyId(key);
  return {
    keyId,
    sign: async <T extends object>(payload: T): Promise<SignedEvidence<T>> => {
      if ("auth" in payload) throw new Error("signed evidence payload must not already contain auth metadata");
      const unsigned = {
        ...payload,
        auth: {
          algorithm: EVIDENCE_AUTH_ALGORITHM,
          keyId,
        },
      };
      const signature = createHmac("sha256", key).update(stableJson(unsigned), "utf8").digest("hex");
      return {
        ...payload,
        auth: {
          algorithm: EVIDENCE_AUTH_ALGORITHM,
          keyId,
          signature,
        },
      };
    },
  };
}

export async function signEvidencePayload<T extends object>(
  payload: T,
  securityDir?: string,
): Promise<SignedEvidence<T>> {
  return (await createEvidenceSigner(securityDir)).sign(payload);
}

export async function verifyEvidenceSignature(
  value: unknown,
  securityDir: string | undefined,
  label: string,
): Promise<void> {
  if (!isRecord(value) || !isEvidenceAuth(value["auth"])) {
    throw new Error(`memory forget --purge-history: ${label} signature is missing or invalid`);
  }
  const auth = value["auth"];
  const key = await loadEvidenceKey(resolveEvidenceSecurityDir(securityDir), false, label);
  const expectedKeyId = evidenceKeyId(key);
  if (auth.keyId !== expectedKeyId) {
    throw new Error(`memory forget --purge-history: ${label} evidence key ID does not match this device`);
  }
  const { auth: _signedAuth, ...payload } = value;
  const unsigned = {
    ...payload,
    auth: {
      algorithm: auth.algorithm,
      keyId: auth.keyId,
    },
  };
  const expected = createHmac("sha256", key).update(stableJson(unsigned), "utf8").digest();
  const actual = Buffer.from(auth.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`memory forget --purge-history: ${label} signature verification failed`);
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function loadEvidenceKey(
  securityDir: string,
  create: boolean,
  label: string,
): Promise<Buffer> {
  const keyPath = join(securityDir, EVIDENCE_KEY_FILE);
  if (create) {
    await mkdir(securityDir, { recursive: true, mode: 0o700 });
    await chmod(securityDir, 0o700).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
    const encoded = `${randomBytes(EVIDENCE_KEY_BYTES).toString("base64")}\n`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(keyPath, "wx", 0o600);
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    } finally {
      await handle?.close();
    }
    await chmod(keyPath, 0o600).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
  }

  let encoded: string;
  try {
    encoded = (await readFile(keyPath, "utf8")).trim();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`memory forget --purge-history: ${label} evidence key is missing on this device`);
    }
    throw error;
  }
  if (process.platform !== "win32") {
    const mode = (await stat(keyPath)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(`memory forget --purge-history: ${label} evidence key permissions are not restricted`);
    }
  }
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) {
    throw new Error(`memory forget --purge-history: ${label} evidence key is invalid`);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== EVIDENCE_KEY_BYTES) {
    throw new Error(`memory forget --purge-history: ${label} evidence key is invalid`);
  }
  return key;
}

function evidenceKeyId(key: Buffer): string {
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function isEvidenceAuth(value: unknown): value is EvidenceAuth {
  return isRecord(value)
    && Object.keys(value).sort().join(",") === "algorithm,keyId,signature"
    && value["algorithm"] === EVIDENCE_AUTH_ALGORITHM
    && typeof value["keyId"] === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(value["keyId"])
    && typeof value["signature"] === "string"
    && /^[0-9a-f]{64}$/u.test(value["signature"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
