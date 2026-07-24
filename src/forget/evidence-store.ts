import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { atomicWrite } from "../storage/atomic-write.js";
import {
  resolveEvidenceSecurityDir,
  stableJson,
  verifyEvidenceSignature,
  type EvidenceSigner,
  type SignedEvidence,
} from "./evidence-auth.js";

export type EvidenceWrite = (path: string, content: string) => Promise<void>;

export function resolveEvidenceRecordsRoot(securityDir?: string): string {
  return join(resolveEvidenceSecurityDir(securityDir), "records");
}

export function evidenceOperationDir(
  kind: "live-erase" | "history-purge",
  operationDigest: string,
  securityDir?: string,
): string {
  if (!/^[0-9a-f]{64}$/u.test(operationDigest)) {
    throw new Error("memory forget: evidence operation digest is invalid");
  }
  return join(resolveEvidenceRecordsRoot(securityDir), kind, operationDigest);
}

export function assertExternalEvidencePath(
  protectedRoot: string,
  evidencePath: string,
  label: string,
): void {
  const relPath = relative(resolve(protectedRoot), resolve(evidencePath));
  if (relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath))) {
    throw new Error(`memory forget: ${label} must be outside the protected repository`);
  }
}

export async function persistVerifiedSignedEvidence<T extends object>(
  path: string,
  payload: T,
  signer: EvidenceSigner,
  securityDir: string | undefined,
  label: string,
  write: EvidenceWrite = atomicWrite,
): Promise<SignedEvidence<T>> {
  const signed = await signer.sign(payload);
  await write(path, `${JSON.stringify(signed, null, 2)}\n`);
  const persisted = await readVerifiedEvidenceFile(path, securityDir, label) as SignedEvidence<T>;
  if (stableJson(persisted) !== stableJson(signed)) {
    throw new Error(`memory forget: ${label} read-back did not match the signed payload`);
  }
  return persisted;
}

export async function readVerifiedEvidenceFile(
  path: string,
  securityDir: string | undefined,
  label: string,
): Promise<unknown> {
  const resolved = resolve(path);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error(`memory forget: ${label} is not a regular file`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`memory forget: ${label} is missing or invalid: ${detail}`);
  }
  await verifyEvidenceSignature(value, securityDir, label);
  return value;
}
