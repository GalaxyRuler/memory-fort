import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureRawSessionFile } from "../../src/hooks/raw-file.js";
import { parseFrontmatter } from "../../src/storage/frontmatter.js";

describe("ensureRawSessionFile identity injection", () => {
  let savedAgentId: string | undefined;
  let savedUserId: string | undefined;

  beforeEach(() => {
    savedAgentId = process.env["MEMORY_FORT_AGENT_ID"];
    savedUserId = process.env["MEMORY_FORT_USER_ID"];
  });

  afterEach(() => {
    if (savedAgentId !== undefined) process.env["MEMORY_FORT_AGENT_ID"] = savedAgentId;
    else delete process.env["MEMORY_FORT_AGENT_ID"];
    if (savedUserId !== undefined) process.env["MEMORY_FORT_USER_ID"] = savedUserId;
    else delete process.env["MEMORY_FORT_USER_ID"];
  });

  it("stamps agent_id and user_id from valid env vars", async () => {
    process.env["MEMORY_FORT_AGENT_ID"] = "codex-prod";
    process.env["MEMORY_FORT_USER_ID"] = "alice";

    const written: Record<string, string> = {};
    await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "test-session-123",
      cwd: "/tmp",
      now: new Date("2026-06-09T10:00:00Z"),
      exists: async () => false,
      write: async (path, content) => {
        written[path] = content;
      },
    });

    const content = Object.values(written)[0]!;
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter.agent_id).toBe("codex-prod");
    expect(parsed.frontmatter.user_id).toBe("alice");
  });

  it("omits identity fields when env vars are unset", async () => {
    delete process.env["MEMORY_FORT_AGENT_ID"];
    delete process.env["MEMORY_FORT_USER_ID"];

    const written: Record<string, string> = {};
    await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "test-session-456",
      cwd: "/tmp",
      now: new Date("2026-06-09T10:00:00Z"),
      exists: async () => false,
      write: async (path, content) => {
        written[path] = content;
      },
    });

    const content = Object.values(written)[0]!;
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter.agent_id).toBeUndefined();
    expect(parsed.frontmatter.user_id).toBeUndefined();
  });

  it("rejects identity values with invalid characters", async () => {
    process.env["MEMORY_FORT_AGENT_ID"] = "valid-agent_1";
    process.env["MEMORY_FORT_USER_ID"] = "invalid\nvalue";

    const written: Record<string, string> = {};
    await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "test-session-789",
      cwd: "/tmp",
      now: new Date("2026-06-09T10:00:00Z"),
      exists: async () => false,
      write: async (path, content) => {
        written[path] = content;
      },
    });

    const content = Object.values(written)[0]!;
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter.agent_id).toBe("valid-agent_1");
    expect(parsed.frontmatter.user_id).toBeUndefined();
  });

  it("rejects identity values longer than 128 chars", async () => {
    process.env["MEMORY_FORT_AGENT_ID"] = "a".repeat(129);
    delete process.env["MEMORY_FORT_USER_ID"];

    const written: Record<string, string> = {};
    await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "test-session-len",
      cwd: "/tmp",
      now: new Date("2026-06-09T10:00:00Z"),
      exists: async () => false,
      write: async (path, content) => {
        written[path] = content;
      },
    });

    const content = Object.values(written)[0]!;
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter.agent_id).toBeUndefined();
  });

  it("allows @ for external account IDs", async () => {
    process.env["MEMORY_FORT_USER_ID"] = "alice@corp";
    delete process.env["MEMORY_FORT_AGENT_ID"];

    const written: Record<string, string> = {};
    await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "test-session-at",
      cwd: "/tmp",
      now: new Date("2026-06-09T10:00:00Z"),
      exists: async () => false,
      write: async (path, content) => {
        written[path] = content;
      },
    });

    const content = Object.values(written)[0]!;
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter.user_id).toBe("alice@corp");
  });
});
