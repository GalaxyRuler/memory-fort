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
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/memory/api": {
        target: "https://srv1317946.tail6916d8.ts.net",
        changeOrigin: true,
        secure: true,
        ws: false,
      },
    },
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
