import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";

export default {
  content: ["./src/dashboard-ui/**/*.{ts,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "#0a0a0f", // app background — near-black, cool blue undertone
        surface: "#0f1117",    // surface-1
        "surface-1": "#0f1117",
        "surface-2": "#161a24",
        "surface-3": "#1e2333",
        "surface-4": "#2a3040",
        "border-subtle": "rgba(255, 255, 255, 0.06)",
        "border-emphasis": "rgba(255, 255, 255, 0.12)",
        "text-primary": "#e8ecf4",
        "text-secondary": "#9ba4b8",
        "text-muted": "#5c6478",
        "text-ghost": "#2e3444",
        primary: "#06b6d4", // cyan-500 as primary
        cyan: {
          50: "#ecfeff",
          100: "#cffafe",
          200: "#a5f3fc",
          300: "#67e8f9",
          400: "#22d3ee",
          500: "#06b6d4",
          600: "#0891b2",
        },
        violet: {
          400: "#a78bfa",
          500: "#8b5cf6",
        },
        amber: {
          400: "#fbbf24",
          500: "#f59e0b",
        },
        status: {
          green: "#10b981", // success
          amber: "#f59e0b", // warning
          red: "#ef4444",   // error
          blue: "#3b82f6",  // info
        },
        entity: {
          projects: "#4ade80",
          decisions: "#f472b6",
          lessons: "#a78bfa",
          references: "#60a5fa",
          tools: "#fbbf24",
          crystals: "#22d3ee",
          people: "#f472b6",
          "raw-session": "#5c6478",
        },
        cognitive: {
          core: "#f0f6fc",
          semantic: "#58a6ff",
          episodic: "#f59e0b",
          procedural: "#3fb950",
        },
      },
      fontFamily: {
        sans: ['"Inter"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SF Mono", "monospace"],
      },
      borderRadius: {
        DEFAULT: "6px",
        sm: "6px",
        md: "10px",
        lg: "14px",
        xl: "20px",
        full: "9999px",
      },
    },
  },
  plugins: [typography],
} satisfies Config;
