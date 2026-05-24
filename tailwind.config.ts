import type { Config } from "tailwindcss";

export default {
  content: ["./src/dashboard-ui/**/*.{ts,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "#09090b",
        surface: "#111114",
        "surface-2": "#18181c",
        "border-subtle": "rgba(255,255,255,0.06)",
        "border-emphasis": "rgba(255,255,255,0.12)",
        "text-primary": "#ededed",
        "text-secondary": "rgba(237,237,237,0.7)",
        "text-muted": "rgba(237,237,237,0.45)",
        accent: { from: "#8b5fff", to: "#5b8bff" },
        primary: "#cebdff",
        status: {
          green: "#4ade80",
          amber: "#fbbf24",
          red: "#f87171",
          blue: "#5b8bff",
        },
        entity: {
          projects: "#5b8bff",
          decisions: "#8b5fff",
          lessons: "#fbbf24",
          references: "#22d3ee",
          tools: "#34d399",
          people: "#f472b6",
          crystals: "#fcd34d",
          "raw-session": "#52525b",
        },
      },
      fontFamily: {
        sans: ['"Inter"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SF Mono", "monospace"],
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem",
      },
    },
  },
  plugins: [],
} satisfies Config;
