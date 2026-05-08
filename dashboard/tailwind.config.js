/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        // Institutional palette. Not crypto-neon.
        bg: "hsl(var(--bg))",
        surface: "hsl(var(--surface))",
        "surface-2": "hsl(var(--surface-2))",
        border: "hsl(var(--border))",
        fg: "hsl(var(--fg))",
        "fg-muted": "hsl(var(--fg-muted))",
        "fg-subtle": "hsl(var(--fg-subtle))",

        // Single accent: muted institutional green for "minted / verified / positive".
        accent: {
          DEFAULT: "hsl(var(--accent))",
          dim: "hsl(var(--accent-dim))",
          fg: "hsl(var(--accent-fg))",
        },
        warn: "hsl(var(--warn))",
        danger: "hsl(var(--danger))",

        // shadcn aliases
        background: "hsl(var(--bg))",
        foreground: "hsl(var(--fg))",
        card: {
          DEFAULT: "hsl(var(--surface))",
          foreground: "hsl(var(--fg))",
        },
        popover: {
          DEFAULT: "hsl(var(--surface))",
          foreground: "hsl(var(--fg))",
        },
        primary: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-fg))",
        },
        secondary: {
          DEFAULT: "hsl(var(--surface-2))",
          foreground: "hsl(var(--fg))",
        },
        muted: {
          DEFAULT: "hsl(var(--surface-2))",
          foreground: "hsl(var(--fg-muted))",
        },
        destructive: {
          DEFAULT: "hsl(var(--danger))",
          foreground: "hsl(var(--fg))",
        },
        input: "hsl(var(--border))",
        ring: "hsl(var(--accent))",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        serif: ["Newsreader", "Iowan Old Style", "ui-serif", "Georgia", "serif"],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        // Numbers-as-hero scale
        hero: ["3.5rem", { lineHeight: "1", letterSpacing: "-0.02em", fontWeight: "500" }],
        stat: ["2rem", { lineHeight: "1.05", letterSpacing: "-0.01em", fontWeight: "500" }],
      },
      borderRadius: {
        lg: "0.625rem",
        md: "0.5rem",
        sm: "0.375rem",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms ease-out",
        "pulse-soft": "pulse-soft 2.5s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
