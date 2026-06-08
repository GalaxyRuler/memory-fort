import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type SyncRunnerResult } from "../../src/dashboard/server.js";

describe("POST /api/sync", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "dash-sync-"));
    await mkdir(join(tmp, ".git"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function mockSyncRunner(result: SyncRunnerResult) {
    return vi.fn(async () => result);
  }

  const defaultResult: SyncRunnerResult = {
    autoCommit: { kind: "committed", filesCount: 3, commitSha: "abc1234" },
    sync: {
      initialState: "behind",
      finalState: "synced",
      actionsPerformed: ["pulled 2 commits", "pushed 1 commit"],
      retried: false,
      conflictFiles: [],
      syncStateFile: { lastSyncAttempt: null, lastSyncSuccess: null },
      remoteName: "origin",
      branch: "main",
    },
  };

  it("commits dirty files and returns sync result", async () => {
    const syncRunner = mockSyncRunner(defaultResult);
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      syncRunner,
    });

    try {
      const origin = `http://${server.host}:${server.port}`;
      const response = await fetch(`${origin}/api/sync`, { method: "POST" });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        ok: true,
        autoCommit: { kind: "committed", filesCount: 3, commitSha: "abc1234" },
        sync: {
          initialState: "behind",
          finalState: "synced",
          actionsPerformed: ["pulled 2 commits", "pushed 1 commit"],
        },
      });
      expect(syncRunner).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("returns 409 when a sync is already running", async () => {
    let resolveSync: ((value: SyncRunnerResult) => void) | null = null;
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const syncRunner = vi.fn(
      () =>
        new Promise<SyncRunnerResult>((resolve) => {
          markStarted?.();
          resolveSync = resolve;
        }),
    );
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      syncRunner,
    });

    try {
      const origin = `http://${server.host}:${server.port}`;
      const first = fetch(`${origin}/api/sync`, { method: "POST" });
      await started;

      const conflict = await fetch(`${origin}/api/sync`, { method: "POST" });
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({ error: "sync already running" });

      resolveSync?.(defaultResult);
      const response = await first;
      expect(response.status).toBe(200);
      expect(syncRunner).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("returns 403 on a read-only vault", async () => {
    await rm(join(tmp, ".git"), { recursive: true, force: true });
    const syncRunner = mockSyncRunner(defaultResult);
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      syncRunner,
    });

    try {
      const origin = `http://${server.host}:${server.port}`;
      const response = await fetch(`${origin}/api/sync`, { method: "POST" });
      expect(response.status).toBe(403);
      expect(syncRunner).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns 500 with error message when sync fails", async () => {
    const syncRunner = vi.fn(async () => {
      throw new Error("git push failed: remote rejected");
    });
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      syncRunner,
    });

    try {
      const origin = `http://${server.host}:${server.port}`;
      const response = await fetch(`${origin}/api/sync`, { method: "POST" });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toEqual({ error: "git push failed: remote rejected" });
      expect(syncRunner).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("returns no-dirty-files autoCommit when nothing to commit", async () => {
    const syncRunner = mockSyncRunner({
      autoCommit: { kind: "no-dirty-files" },
      sync: {
        initialState: "synced",
        finalState: "synced",
        actionsPerformed: [],
        retried: false,
        conflictFiles: [],
        syncStateFile: { lastSyncAttempt: null, lastSyncSuccess: null },
        remoteName: "origin",
        branch: "main",
      },
    });
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      syncRunner,
    });

    try {
      const origin = `http://${server.host}:${server.port}`;
      const response = await fetch(`${origin}/api/sync`, { method: "POST" });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        ok: true,
        autoCommit: { kind: "no-dirty-files" },
        sync: {
          initialState: "synced",
          finalState: "synced",
          actionsPerformed: [],
        },
      });
    } finally {
      await server.close();
    }
  });

  it("rejects cross-origin requests with 403", async () => {
    const syncRunner = mockSyncRunner(defaultResult);
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      syncRunner,
    });

    try {
      const origin = `http://${server.host}:${server.port}`;
      const response = await fetch(`${origin}/api/sync`, {
        method: "POST",
        headers: { Origin: "https://evil.example.com" },
      });
      expect(response.status).toBe(403);
      expect(syncRunner).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
