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
        manualChunks(id) {
          const moduleId = id.replace(/\\/g, "/");
          if (moduleId.includes("/node_modules/@tanstack/")) {
            return "tanstack";
          }
          if (moduleId.includes("/node_modules/lucide-react")) {
            return "icons";
          }
          if (
            moduleId.includes("/node_modules/react-markdown/") ||
            moduleId.includes("/node_modules/remark-") ||
            moduleId.includes("/node_modules/rehype-") ||
            moduleId.includes("/node_modules/unified/") ||
            moduleId.includes("/node_modules/micromark") ||
            moduleId.includes("/node_modules/mdast-") ||
            moduleId.includes("/node_modules/hast-") ||
            moduleId.includes("/node_modules/unist-") ||
            moduleId.includes("/node_modules/vfile")
          ) {
            return "markdown";
          }
          if (
            moduleId.includes("/src/dashboard-ui/components/galactic/") ||
            moduleId.endsWith("/src/dashboard-ui/components/GalacticCanvas.tsx") ||
            moduleId.endsWith("/src/dashboard-ui/components/GraphPage.tsx")
          ) {
            return "graph";
          }
          if (
            moduleId.endsWith("/src/dashboard-ui/components/SettingsPage.tsx") ||
            moduleId.endsWith("/src/dashboard-ui/components/LLMConfigCard.tsx") ||
            moduleId.endsWith("/src/dashboard-ui/components/EmbedderConfigCard.tsx")
          ) {
            return "settings";
          }
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
