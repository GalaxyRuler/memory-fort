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
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
