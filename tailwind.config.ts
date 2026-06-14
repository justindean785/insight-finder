import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        chat: ['Inter', 'Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        condensed: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['ui-serif', 'Georgia', 'serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Semantic type scale — replaces ad-hoc inline `text-[Xpx]`. Reading text
      // (`data` and up) is floored at 12px for legibility; `eyebrow` is the only
      // sub-12px size and is reserved for uppercase labels/badges, never prose.
      fontSize: {
        eyebrow: ['0.625rem', { lineHeight: '1', letterSpacing: '0.14em' }], // 10px — uppercase labels only
        data: ['0.75rem', { lineHeight: '1.45' }],                            // 12px — dense data / table cells (reading floor)
        meta: ['0.8125rem', { lineHeight: '1.5' }],                           // 13px — secondary/body-supporting
        body: ['0.875rem', { lineHeight: '1.6' }],                            // 14px — body
        title: ['1rem', { lineHeight: '1.3', letterSpacing: '-0.01em' }],     // 16px — section titles
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        success: "hsl(var(--success))",
        info: "hsl(var(--info))",
        warning: "hsl(var(--warning))",
        danger: "hsl(var(--danger))",
        "info-muted": "hsl(var(--info-muted))",
        "success-muted": "hsl(var(--success-muted))",
        "warning-muted": "hsl(var(--warning-muted))",
        "danger-muted": "hsl(var(--danger-muted))",
        highconf: "hsl(var(--highconf))",
        evidence: "hsl(var(--evidence))",
        "confidence-high": "hsl(var(--confidence-high))",
        "confidence-mid": "hsl(var(--confidence-mid))",
        "confidence-low": "hsl(var(--confidence-low))",
        "surface-0": "hsl(var(--surface-0))",
        "surface-1": "hsl(var(--surface-1))",
        "surface-2": "hsl(var(--surface-2))",
        "surface-3": "hsl(var(--surface-3))",
        "surface-4": "hsl(var(--surface-4))",
        "border-subtle": "hsl(var(--border-subtle))",
        "border-strong": "hsl(var(--border-strong))",
        "brain-surface": "hsl(var(--brain-surface-base))",
        "brain-card": "hsl(var(--brain-card))",
        "brain-border": "hsl(var(--brain-border))",
        "brain-text": "hsl(var(--brain-text))",
        "brain-muted": "hsl(var(--brain-muted))",
        "brain-cyan": "hsl(var(--brain-cyan))",
        "brain-ok": "hsl(var(--brain-status-ok))",
        "brain-warn": "hsl(var(--brain-status-warn))",
        "brain-bad": "hsl(var(--brain-status-bad))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
