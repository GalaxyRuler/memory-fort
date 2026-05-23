import { defineConfig } from "tsdown";

const common = {
  format: "esm",
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
} as const;

export default defineConfig([
  {
    ...common,
    entry: { index: "src/index.ts" },
    clean: true,
  },
  {
    ...common,
    entry: { cli: "src/cli.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "sync/auto-push": "src/sync/auto-push.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "sync/auto-commit-raws": "src/sync/auto-commit-raws.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "sync/auto-push-worker": "src/sync/auto-push-worker.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "dashboard/server": "src/dashboard/server.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/corpus": "src/retrieval/corpus.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/bm25": "src/retrieval/bm25.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/exact": "src/retrieval/exact.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/embeddings-store": "src/retrieval/embeddings-store.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/refresh": "src/retrieval/refresh.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/voyage-client": "src/retrieval/voyage-client.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/graph": "src/retrieval/graph.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/metadata-score": "src/retrieval/metadata-score.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "storage/config": "src/storage/config.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "hooks/auto-push-worker": "src/sync/auto-push-worker.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "hooks/prompt-submit": "src/hooks/prompt-submit.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "hooks/post-tool-use": "src/hooks/post-tool-use.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "hooks/pre-compact": "src/hooks/pre-compact.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "hooks/session-end": "src/hooks/session-end.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "hooks/session-start": "src/hooks/session-start.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "hooks/mcp-server": "src/mcp/server.ts" },
    clean: false,
    dts: false,
  },
]);
