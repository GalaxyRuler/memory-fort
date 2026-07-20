import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptSubmitBody } from "../../src/hooks/prompt-submit.js";

describe("promptSubmitBody", () => {
  const fixedNow = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));

  it("appends a prompt block via the injected helpers", async () => {
    const calls: any[] = [];
    await promptSubmitBody(
      { session_id: "abc", cwd: "C:\\test", prompt: "hello world" },
      {
        detectTool: () => "claude-code",
        ensureRawSessionFile: async (i) => {
          calls.push({ kind: "ensure", ...i });
          return "/fake/path";
        },
        appendBlock: async (i) => {
          calls.push({ kind: "append", ...i });
        },
        now: () => fixedNow,
      },
    );
    expect(calls[0].kind).toBe("ensure");
    expect(calls[0].tool).toBe("claude-code");
    expect(calls[0].sessionId).toBe("abc");
    expect(calls[1].kind).toBe("append");
    expect(calls[1].block).toContain("hello world");
    expect(calls[1].block).toContain("12:00:00");
  });

  it("skips when prompt is empty/whitespace", async () => {
    const calls: any[] = [];
    await promptSubmitBody(
      { session_id: "abc", cwd: "C:\\test", prompt: "   " },
      {
        detectTool: () => "claude-code",
        ensureRawSessionFile: async (i) => {
          calls.push({ kind: "ensure", ...i });
          return "/fake/path";
        },
        appendBlock: async (i) => {
          calls.push({ kind: "append", ...i });
        },
      },
    );
    expect(calls.length).toBe(0);
  });

  it("falls back to 'unknown' session_id when missing", async () => {
    let captured: any = null;
    await promptSubmitBody(
      { prompt: "x" },
      {
        detectTool: () => "codex",
        ensureRawSessionFile: async (i) => {
          captured = i;
          return "/fake/path";
        },
        appendBlock: async () => {},
        now: () => fixedNow,
      },
    );
    expect(captured.sessionId).toBe("unknown");
    expect(captured.tool).toBe("codex");
  });

  it("accepts Codex-style prompt fields", async () => {
    const calls: any[] = [];
    await promptSubmitBody(
      {
        turn_id: "turn-123",
        working_directory: "C:\\repo",
        user_prompt: "codex prompt",
      },
      {
        detectTool: () => "codex",
        ensureRawSessionFile: async (i) => {
          calls.push({ kind: "ensure", ...i });
          return "/fake/path";
        },
        appendBlock: async (i) => {
          calls.push({ kind: "append", ...i });
        },
        now: () => fixedNow,
      },
    );
    expect(calls[0].sessionId).toBe("turn-123");
    expect(calls[0].cwd).toBe("C:\\repo");
    expect(calls[1].block).toContain("codex prompt");
  });
});

describe("prompt-driven retrieval", () => {
  const fixedNow = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "prompt-retrieval-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function searchResponse(results: unknown[]): Response {
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async function run(opts: {
    sessionContent: string;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ out: string[]; fetched: string[] }> {
    const sessionPath = join(tmp, "session.md");
    await writeFile(sessionPath, opts.sessionContent, "utf-8");
    const out: string[] = [];
    const fetched: string[] = [];
    await promptSubmitBody(
      { session_id: "abc", cwd: tmp, prompt: "how does the scheduler heartbeat work" },
      {
        detectTool: () => "claude-code",
        ensureRawSessionFile: async () => sessionPath,
        appendBlock: async () => {},
        now: () => fixedNow,
        env: opts.env ?? {},
        write: (text) => { out.push(text); },
        fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
          fetched.push(String(input));
          if (opts.fetchImpl) return opts.fetchImpl(input, init);
          return searchResponse([
            { path: "raw/2026-07-20/echo.md", title: "echo", snippet: "raw echo" },
            { path: "wiki/lessons/scheduler.md", title: "Scheduler", snippet: "persisted last-run stamps" },
            { path: "wiki/.audit/x.md", title: "audit", snippet: "operational" },
            { path: "wiki/compile-proposed/y.md", title: "draft", snippet: "staged" },
            { path: "wiki/projects/memory-system.md", title: "Memory System", snippet: "cross-tool memory" },
          ]);
        }) as typeof fetch,
      },
    );
    return { out, fetched };
  }

  it("emits curated wiki hits on the first prompt, filtering raw and dot-dir results", async () => {
    const { out, fetched } = await run({ sessionContent: "---\nsource: claude-code\n---\n" });

    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("/api/search?q=");
    const text = out.join("");
    expect(text).toContain("[memory:prompt-retrieval]");
    expect(text).toContain("wiki/lessons/scheduler.md");
    expect(text).toContain("wiki/projects/memory-system.md");
    expect(text).not.toContain("raw/2026-07-20/echo.md");
    expect(text).not.toContain("wiki/.audit");
    expect(text).not.toContain("compile-proposed");
  });

  it("does not search on later prompts of the same session", async () => {
    const { out, fetched } = await run({
      sessionContent: "---\nsource: claude-code\n---\n\n## [11:00:00] Prompt\n\nearlier prompt\n",
    });

    expect(fetched).toHaveLength(0);
    expect(out).toHaveLength(0);
  });

  it("stays silent when the search backend is unreachable", async () => {
    const { out } = await run({
      sessionContent: "---\nsource: claude-code\n---\n",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    });

    expect(out).toHaveLength(0);
  });

  it("honors the MEMORY_PROMPT_RETRIEVAL=0 kill switch", async () => {
    const { out, fetched } = await run({
      sessionContent: "---\nsource: claude-code\n---\n",
      env: { MEMORY_PROMPT_RETRIEVAL: "0" },
    });

    expect(fetched).toHaveLength(0);
    expect(out).toHaveLength(0);
  });
});
