import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", {
    stdio: ["pipe", "pipe", "ignore"],
  })
    .toString()
    .trim();
} catch {
  // Build still works outside a git checkout; schema.md will record "unknown".
}

const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf-8"));

const common = {
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  checks: { pluginTimings: false },
  define: {
    __MEMORY_BUILD_COMMIT__: JSON.stringify(commit),
    __MEMORY_BUILD_VERSION__: JSON.stringify(pkg.version),
  },
};

const serverClean = [
  "dist/*.mjs",
  "dist/*.d.mts",
  "dist/*.mjs.map",
  "dist/sync",
  "dist/dashboard",
  "dist/retrieval",
  "dist/storage",
  "dist/hooks",
  "dist/cli",
];

export default defineConfig([
  {
    ...common,
    entry: { index: "src/index.ts" },
    clean: serverClean,
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
    entry: { "dashboard/dashboard-service": "src/dashboard/dashboard-service.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "dashboard/scheduled-vault-worker": "src/dashboard/scheduled-vault-worker.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "dashboard/verify-worker": "src/dashboard/verify-worker.ts" },
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
    entry: { "retrieval/rebless": "src/retrieval/rebless.ts" },
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
    entry: { "retrieval/rrf": "src/retrieval/rrf.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/rerank": "src/retrieval/rerank.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/hyde": "src/retrieval/hyde.ts" },
    clean: false,
  },
  {
    ...common,
    entry: { "retrieval/search": "src/retrieval/search.ts" },
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
    entry: { "hooks/opencode-event": "src/hooks/opencode-event.ts" },
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
    deps: { onlyBundle: ["zod"] },
  },
  {
    ...common,
    entry: { "mcp/http-bridge": "src/mcp/http-bridge.ts" },
    clean: false,
    dts: false,
    deps: { onlyBundle: ["zod"] },
  },
  {
    ...common,
    entry: { "electron-main": "electron/main.ts" },
    deps: { neverBundle: ["electron"] },
    dts: false,
    clean: false,
  },
]);
