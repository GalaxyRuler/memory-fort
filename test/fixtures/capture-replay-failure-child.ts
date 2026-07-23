import { appendBlock } from "../../src/hooks/raw-file.js";

await appendBlock({
  tool: "codex",
  sessionId: "child-replay-failure",
  block: "\n## [04:00:01] Prompt\n\nchild hook completed\n",
  now: new Date("2026-07-23T04:00:01.000Z"),
});
