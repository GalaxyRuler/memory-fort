import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../../src/storage/frontmatter.js";
import { runSniffer } from "../../src/sniffers/run-sniffer.js";
import type { RawSession, Sniffer } from "../../src/sniffers/types.js";

describe("runSniffer", () => {
  let tmp: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "run-sniffer-"));
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes raw session markdown with frontmatter and reports duplicate bodies", async () => {
    const sessions: RawSession[] = [
      {
        source: "claude-code",
        sessionId: "session/one",
        startedAt: "2026-05-24T10:00:00.000Z",
        updatedAt: "2026-05-24T10:05:00.000Z",
        cwd: "C:/work/demo",
        body: "## [10:00:00] Prompt\n\nhello\n",
      },
      {
        source: "claude-code",
        sessionId: "session-two",
        startedAt: "2026-05-24T11:00:00.000Z",
        updatedAt: "2026-05-24T11:05:00.000Z",
        body: "## [10:00:00] Prompt\n\nhello\n",
      },
    ];
    const sniffer = snifferWithSessions(sessions);

    const result = await runSniffer(sniffer, { limit: 10 });

    expect(result.written).toEqual(["raw/2026-05-24/claude-code-session_one.md"]);
    expect(result.skipped).toEqual([
      {
        relPath: "raw/2026-05-24/claude-code-session_one.md",
        sessionId: "session-two",
        reason: "duplicate-content",
      },
    ]);
    const filePath = join(tmp, "raw", "2026-05-24", "claude-code-session_one.md");
    expect(existsSync(filePath)).toBe(true);
    const parsed = parseFrontmatter(await readFile(filePath, "utf-8"));
    expect(parsed.frontmatter).toMatchObject({
      type: "raw-session",
      title: "claude-code session session/one",
      created: "2026-05-24",
      updated: "2026-05-24",
      source: "claude-code",
      session: "session/one",
      cwd: "C:/work/demo",
      capture_hash: expect.any(String),
    });
    expect(parsed.body.trimStart()).toBe("## [10:00:00] Prompt\n\nhello\n");
  });

  it("honors the list limit before writing sessions", async () => {
    const sniffer = snifferWithSessions([
      rawSession("one", "first"),
      rawSession("two", "second"),
    ]);

    const result = await runSniffer(sniffer, { limit: 1 });

    expect(result.written).toEqual(["raw/2026-05-24/codex-one.md"]);
    expect(existsSync(join(tmp, "raw", "2026-05-24", "codex-two.md"))).toBe(false);
  });

  it("redacts shaped secrets before writing sniffer backfill sessions", async () => {
    const sniffer = snifferWithSessions([
      rawSession("secret", "OPENROUTER_API_KEY=sk-sniffer-secret-material-123456"),
    ]);

    const result = await runSniffer(sniffer, { limit: 1 });

    expect(result.written).toEqual(["raw/2026-05-24/codex-secret.md"]);
    const filePath = join(tmp, "raw", "2026-05-24", "codex-secret.md");
    const parsed = parseFrontmatter(await readFile(filePath, "utf-8"));
    expect(parsed.body).toContain("[REDACTED]");
    expect(parsed.body).not.toContain("sk-sniffer-secret-material");
  });
});

function rawSession(sessionId: string, body: string): RawSession {
  return {
    source: "codex",
    sessionId,
    startedAt: "2026-05-24T10:00:00.000Z",
    updatedAt: "2026-05-24T10:05:00.000Z",
    body,
  };
}

function snifferWithSessions(sessions: RawSession[]): Sniffer {
  return {
    name: "test",
    available: async () => true,
    list: async function* (opts) {
      for (const session of sessions.slice(0, opts.limit)) {
        yield session;
      }
    },
  };
}
