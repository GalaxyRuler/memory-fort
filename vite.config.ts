import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/dashboard-ui",
  base: "/memory/",
  build: {
    outDir: resolve(__dirname, "dist/dashboard-ui"),
    emptyOutDir: true,
    sourcemap: true,
  },
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "routes",
      generatedRouteTree: "routeTree.gen.ts",
    }),
    react(),
  ],
});
