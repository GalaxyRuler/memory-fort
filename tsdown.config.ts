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
]);
