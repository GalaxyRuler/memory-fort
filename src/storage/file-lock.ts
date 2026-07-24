import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { atomicWrite } from "./atomic-write.js";

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  testHooks?: {
    afterStaleSnapshotConfirmed?: () => Promise<void>;
    afterStaleReclaimed?: () => Promise<void>;
  };
}

interface FileLockClaim {
  version: 2;
  pid: number;
  host: string;
  acquiredAt: string;
  ownerToken: string;
  choosing: boolean;
  ticket: number | null;
}

interface ClaimSnapshot {
  path: string;
  mtimeMs: number;
  claim: FileLockClaim | null;
}

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`could not acquire ${lockPath} within ${timeoutMs}ms (held by another process)`);
    this.name = "FileLockTimeoutError";
  }
}

/**
 * Cross-process Lamport bakery lock.
 *
 * `${targetPath}.lock` is a permanent claim directory. Each contender creates,
 * heartbeats, and removes only its own UUID-named claim. Deterministic
 * `(ticket, ownerToken)` ordering supplies mutual exclusion without ever
 * renaming or unlinking a shared successor pathname.
 *
 * A pre-v2 shared lock file is honored until its owner removes it. Once absent,
 * the directory is created as a permanent one-way migration barrier: older
 * shared-file implementations can no longer publish a successor at that path.
 */
export async function withFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  const owner: FileLockClaim = {
    version: 2,
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ownerToken: randomUUID(),
    choosing: true,
    ticket: null,
  };

  await mkdir(dirname(lockPath), { recursive: true });
  await waitForClaimDirectory(lockPath, deadline, timeoutMs, pollMs);
  await reclaimStaleClaims(lockPath, staleMs, opts.testHooks);

  const claimPath = join(lockPath, `${owner.ownerToken}.json`);
  await createClaim(claimPath, owner);
  const stopHeartbeat = startOwnedHeartbeat(
    claimPath,
    owner.ownerToken,
    staleMs,
    opts.heartbeatMs,
  );
  try {
    const ticket = await chooseTicket(
      lockPath,
      claimPath,
      owner,
      deadline,
      timeoutMs,
      pollMs,
      staleMs,
      opts.testHooks,
    );
    await waitForTurn(
      lockPath,
      claimPath,
      { ...owner, choosing: false, ticket },
      deadline,
      timeoutMs,
      pollMs,
      staleMs,
      opts.testHooks,
    );
    return await operation();
  } finally {
    await stopHeartbeat();
    // The UUID path is never reused, so release cannot target a successor.
    await unlink(claimPath).catch((error) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}

/** Whether a legacy lock file or at least one v2 unique claim is present. */
export function isFileLockHeld(targetPath: string): boolean {
  const lockPath = `${targetPath}.lock`;
  if (!existsSync(lockPath)) return false;
  try {
    if (!statSync(lockPath).isDirectory()) return true;
    return readdirSync(lockPath).some((name) => name.endsWith(".json"));
  } catch {
    return true;
  }
}

/**
 * Retained for callers that classify filesystem contention errors. The bakery
 * protocol itself uses EEXIST only for atomic unique-claim creation/migration.
 */
export function isLockContentionError(error: unknown): boolean {
  return isCode(error, "EEXIST") || isCode(error, "EPERM") || isCode(error, "EACCES");
}

async function waitForClaimDirectory(
  lockPath: string,
  deadline: number,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  while (true) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (!isLockContentionError(error)) throw error;
    }

    try {
      if ((await stat(lockPath)).isDirectory()) return;
      // Legacy shared-file locks are observed, never reaped: deleting the
      // shared name after a snapshot could delete a live old-version successor.
    } catch (error) {
      if (isCode(error, "ENOENT")) continue;
      throw error;
    }
    await waitOrTimeout(lockPath, deadline, timeoutMs, pollMs);
  }
}

async function createClaim(path: string, claim: FileLockClaim): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf-8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function chooseTicket(
  lockPath: string,
  claimPath: string,
  owner: FileLockClaim,
  deadline: number,
  timeoutMs: number,
  pollMs: number,
  staleMs: number,
  hooks?: FileLockOptions["testHooks"],
): Promise<number> {
  while (true) {
    await reclaimStaleClaims(lockPath, staleMs, hooks, claimPath);
    const snapshots = await readClaimSnapshots(lockPath);
    if (snapshots.every((snapshot) => snapshot.claim !== null)) {
      const maxTicket = snapshots.reduce(
        (max, snapshot) => Math.max(max, snapshot.claim?.ticket ?? 0),
        0,
      );
      if (maxTicket >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`file lock ticket space exhausted for ${lockPath}`);
      }
      const ticket = maxTicket + 1;
      await writeOwnedClaim(claimPath, {
        ...owner,
        choosing: false,
        ticket,
      });
      return ticket;
    }
    await waitOrTimeout(lockPath, deadline, timeoutMs, pollMs);
  }
}

async function waitForTurn(
  lockPath: string,
  claimPath: string,
  owner: FileLockClaim & { ticket: number },
  deadline: number,
  timeoutMs: number,
  pollMs: number,
  staleMs: number,
  hooks?: FileLockOptions["testHooks"],
): Promise<void> {
  while (true) {
    await reclaimStaleClaims(lockPath, staleMs, hooks, claimPath);
    const snapshots = await readClaimSnapshots(lockPath);
    let blocked = false;
    for (const snapshot of snapshots) {
      if (snapshot.path === claimPath) continue;
      const other = snapshot.claim;
      if (!other || other.choosing || other.ticket === null) {
        blocked = true;
        break;
      }
      if (claimPrecedes({ ticket: other.ticket, ownerToken: other.ownerToken }, owner)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return;
    await waitOrTimeout(lockPath, deadline, timeoutMs, pollMs);
  }
}

function claimPrecedes(
  other: { ticket: number; ownerToken: string },
  owner: { ticket: number; ownerToken: string },
): boolean {
  return other.ticket < owner.ticket
    || (other.ticket === owner.ticket && other.ownerToken.localeCompare(owner.ownerToken) < 0);
}

async function reclaimStaleClaims(
  lockPath: string,
  staleMs: number,
  hooks?: FileLockOptions["testHooks"],
  ownClaimPath?: string,
): Promise<void> {
  for (const snapshot of await readClaimSnapshots(lockPath)) {
    if (snapshot.path === ownClaimPath || Date.now() - snapshot.mtimeMs <= staleMs) continue;
    if (!snapshot.claim || !(await isSameHostHolderConfirmedDead(snapshot.claim))) continue;
    await hooks?.afterStaleSnapshotConfirmed?.();
    if (await reclaimExactUniqueClaim(snapshot)) {
      await hooks?.afterStaleReclaimed?.();
    }
  }
}

async function reclaimExactUniqueClaim(expected: ClaimSnapshot): Promise<boolean> {
  const current = await readClaimSnapshot(expected.path);
  if (!current || !current.claim || !expected.claim) return false;
  if (
    current.claim.ownerToken !== expected.claim.ownerToken
    || current.claim.pid !== expected.claim.pid
    || current.claim.host !== expected.claim.host
  ) return false;

  // Claim paths contain the immutable owner token and are never successors.
  // A delayed reaper can therefore delete only this confirmed-dead owner's
  // exact path; ENOENT means another reaper already completed the same work.
  try {
    await unlink(expected.path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function readClaimSnapshots(lockPath: string): Promise<ClaimSnapshot[]> {
  let names: string[];
  try {
    names = (await readdir(lockPath)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  return Promise.all(names.map((name) => readClaimSnapshot(join(lockPath, name)).then((snapshot) =>
    snapshot ?? { path: join(lockPath, name), mtimeMs: Date.now(), claim: null }
  )));
}

async function readClaimSnapshot(path: string): Promise<ClaimSnapshot | null> {
  try {
    const [info, raw] = await Promise.all([stat(path), readFile(path, "utf-8")]);
    return { path, mtimeMs: info.mtimeMs, claim: parseClaim(raw) };
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    return { path, mtimeMs: Date.now(), claim: null };
  }
}

function parseClaim(raw: string): FileLockClaim | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const claim = value as Record<string, unknown>;
  if (
    claim.version !== 2
    || typeof claim.pid !== "number"
    || !Number.isInteger(claim.pid)
    || claim.pid <= 0
    || typeof claim.host !== "string"
    || claim.host.length === 0
    || typeof claim.acquiredAt !== "string"
    || typeof claim.ownerToken !== "string"
    || claim.ownerToken.length === 0
    || typeof claim.choosing !== "boolean"
    || (claim.ticket !== null
      && (typeof claim.ticket !== "number"
        || !Number.isSafeInteger(claim.ticket)
        || claim.ticket <= 0))
  ) return null;
  return claim as unknown as FileLockClaim;
}

async function isSameHostHolderConfirmedDead(claim: FileLockClaim): Promise<boolean> {
  if (claim.host !== hostname()) return false;
  try {
    process.kill(claim.pid, 0);
    return false;
  } catch (error) {
    return isCode(error, "ESRCH");
  }
}

async function writeOwnedClaim(path: string, claim: FileLockClaim): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(claim)}\n`);
}

function startOwnedHeartbeat(
  claimPath: string,
  ownerToken: string,
  staleMs: number,
  requestedHeartbeatMs?: number,
): () => Promise<void> {
  const safeCeiling = Math.max(1, Math.floor(staleMs / 2));
  const intervalMs = Math.max(
    1,
    Math.min(requestedHeartbeatMs ?? Math.max(1, Math.floor(staleMs / 3)), safeCeiling),
  );
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = Promise.resolve();
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = refreshOwnedClaim(claimPath, ownerToken)
        .then((stillOwner) => {
          if (stillOwner) schedule();
        })
        .catch(() => undefined);
    }, intervalMs);
  };
  schedule();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}

async function refreshOwnedClaim(path: string, ownerToken: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r+");
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    const claim = parseClaim(await handle.readFile("utf-8"));
    if (claim?.ownerToken !== ownerToken) return false;
    const now = new Date();
    await handle.utimes(now, now);
    return true;
  } finally {
    await handle.close();
  }
}

async function waitOrTimeout(
  lockPath: string,
  deadline: number,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
  await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
