import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
    __MEMORY_BUILD_VERSION__: JSON.stringify("0.0.0-test"),
    __MEMORY_BUILD_COMMIT__: JSON.stringify("test"),
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [
      ["test/dashboard-ui/**/*.test.tsx", "jsdom"],
      ["**/*.test.ts", "node"],
    ],
    setupFiles: ["test/dashboard-ui/setup.ts"],
    passWithNoTests: true,
    reporters: ["default"],
    hookTimeout: 120_000,
    // 60s was tight for test/dashboard/server.test.ts, which spins up real HTTP
    // servers and issues real fetch()/http.request() calls over real loopback
    // sockets (not mocked). On a noisy/cold shared CI runner that occasionally
    // exceeds 60s even running alone on its own dedicated runner (observed:
    // 60002ms, and repeated failures at exactly 60000ms). A per-file/per-suite
    // override via vi.setConfig() in beforeAll does NOT take effect for
    // testTimeout (verified: a beforeAll-scoped vi.setConfig({testTimeout:1000})
    // failed to time out a 2s test) -- global config is the only lever that
    // actually governs the enforced ceiling. See verify-tests-slow-flaky memory.
    testTimeout: 120_000,
  },
});
