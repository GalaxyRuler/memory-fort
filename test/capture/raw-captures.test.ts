import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { listRawCaptureFiles, parseRawCaptureSourceFromFilename } from "../../src/capture/raw-captures.js";

describe("parseRawCaptureSourceFromFilename — new clients", () => {
  it("detects chatgpt", () => {
    expect(parseRawCaptureSourceFromFilename("chatgpt-session-abc123.md")).toBe("chatgpt");
  });
  it("detects opencode", () => {
    expect(parseRawCaptureSourceFromFilename("opencode-abc123.md")).toBe("opencode");
  });
  it("detects hermes", () => {
    expect(parseRawCaptureSourceFromFilename("hermes-abc123.md")).toBe("hermes");
  });
  it("detects pi", () => {
    expect(parseRawCaptureSourceFromFilename("pi-abc123.md")).toBe("pi");
  });
  it("detects openclaw", () => {
    expect(parseRawCaptureSourceFromFilename("openclaw-abc123.md")).toBe("openclaw");
  });
  it("detects opencoven", () => {
    expect(parseRawCaptureSourceFromFilename("opencoven-abc123.md")).toBe("opencoven");
  });
  it("detects vscode", () => {
    expect(parseRawCaptureSourceFromFilename("vscode-abc123.md")).toBe("vscode");
  });
  it("still returns unknown for unrecognized prefix", () => {
    expect(parseRawCaptureSourceFromFilename("unknown-tool-abc.md")).toBe("unknown");
  });
  it("still detects existing sources", () => {
    expect(parseRawCaptureSourceFromFilename("claude-code-session-x.md")).toBe("claude-code");
    expect(parseRawCaptureSourceFromFilename("codex-abc.md")).toBe("codex");
    expect(parseRawCaptureSourceFromFilename("antigravity-abc.md")).toBe("antigravity");
    expect(parseRawCaptureSourceFromFilename("claude-desktop-abc.md")).toBe("claude-desktop");
    expect(parseRawCaptureSourceFromFilename("manual-abc.md")).toBe("manual");
  });

  it("keeps archive and system raw captures out of default activity scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "raw-captures-"));
    try {
      await mkdir(join(root, "raw", "2026-07-24"), { recursive: true });
      await mkdir(join(root, "raw", "Archive", "2026-07-24"), { recursive: true });
      await mkdir(join(root, "raw", "_archive", "2026-07-24"), { recursive: true });
      await writeFile(join(root, "raw", "2026-07-24", "codex-live.md"), "live");
      await writeFile(join(root, "raw", "2026-07-24", ".codex-system.md"), "system");
      await writeFile(join(root, "raw", "Archive", "2026-07-24", "codex-archive.md"), "archive");
      await writeFile(join(root, "raw", "_archive", "2026-07-24", "codex-maintenance.md"), "maintenance archive");

      await expect(listRawCaptureFiles(root)).resolves.toMatchObject([
        { relPath: "raw/2026-07-24/codex-live.md" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
