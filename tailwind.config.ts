import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
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
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        chat: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        condensed: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Display face — Sora (geometric) against the humanist IBM Plex Sans body:
        // a real contrast axis rather than two near-identical sans-serifs. Reserved
        // for hero/case titles and top-level section headings.
        display: ['"Sora"', '"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Figure face — Newsreader, a light text serif. Reserved for NUMERALS
        // and case titles: the register's confidence figures, the masthead
        // stat block, the case name. It is what makes the workspace read as a
        // document rather than as a dashboard. `opsz` is deliberately NOT
        // requested (it costs ~191KB against ~46KB pinned, and the face only
        // renders at large sizes here, so the optical-size axis buys nothing).
        // This slot was 100% dead before — zero consumers — so wiring it is
        // purely additive and cannot restyle an existing heading.
        serif: ['"Newsreader"', 'ui-serif', 'Georgia', 'serif'],
        figure: ['"Newsreader"', 'ui-serif', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Semantic type scale — one ladder from dense labels to hero titles, so
      // hierarchy comes from SIZE, not from making everything an uppercase label.
      // Reading text floors at `micro` (11px); `eyebrow` (10px) is uppercase
      // labels/badges only, never prose. Headings (`h3`→`display`) are tokenized
      // so titles stop being one-off `text-[Npx]` arbitraries; the heading side
      // holds a ~1.25 ratio ladder for real hierarchy. Fixed rem (product
      // register), not clamp — users view at consistent DPI.
      fontSize: {
        // size-only so each label keeps its own `tracking-[...]`; never used for prose
        eyebrow: ['0.625rem', { lineHeight: '1.1' }],                          // 10px — uppercase labels/badges only
        micro: ['0.6875rem', { lineHeight: '1.35' }],                          // 11px — dense reading floor (replaces sub-10px)
        data: ['0.75rem', { lineHeight: '1.45' }],                             // 12px — dense data / table cells
        meta: ['0.8125rem', { lineHeight: '1.5' }],                            // 13px — secondary / body-supporting
        body: ['0.875rem', { lineHeight: '1.6' }],                             // 14px — body prose
        title: ['1rem', { lineHeight: '1.3', letterSpacing: '-0.01em' }],      // 16px — section titles
        h3: ['1.1875rem', { lineHeight: '1.3', letterSpacing: '-0.014em' }],   // 19px — sub-headings
        h2: ['1.5rem', { lineHeight: '1.2', letterSpacing: '-0.02em' }],       // 24px — panel / section headings
        h1: ['1.875rem', { lineHeight: '1.15', letterSpacing: '-0.025em' }],   // 30px — case / page titles
        display: ['2.5rem', { lineHeight: '1.05', letterSpacing: '-0.03em' }], // 40px — hero ceiling (fixed, no clamp)
      },
      transitionTimingFunction: {
        premium: "cubic-bezier(0.32, 0.72, 0, 1)",
        // THE motion curve for the workspace: fast out, gentle settle. Every
        // state transition (tabs, menus, drawers, disclosure) uses this one.
        standard: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      },
      // Motion tokens. Three durations, no others: `fast` for hover/press
      // feedback, `standard` for state changes and menus, `slow` for panels
      // entering. Declared here so `duration-standard` means one thing.
      transitionDuration: {
        fast: "120ms",
        standard: "180ms",
        slow: "240ms",
      },
      boxShadow: {
        // The primary CTA casts a shadow AND a faint signal bloom, so a white
        // pill on the dark ground reads as lit rather than as pasted on.
        cta: "0 10px 28px -12px hsl(0 0% 0% / 0.7), 0 0 34px -14px hsl(var(--brand) / 0.55)",
        // Elevation ladder — deliberate depth steps for the surface hierarchy
        // (raised panel → floating control → overlay). Defined, contained blur
        // with a top inner hairline, not the wide soft "ghost-card" halo.
        // The inner hairlines are the FILM, not pure white: a #fff specular on
        // a blue-black ground is the same leak the `white` remap below exists
        // to close, and these four shadows sat outside it.
        "e1": "inset 0 1px 0 hsl(var(--film) / 0.045), 0 1px 2px hsl(0 0% 0% / 0.4)",
        "e2": "inset 0 1px 0 hsl(var(--film) / 0.055), 0 4px 10px -4px hsl(0 0% 0% / 0.5)",
        "e3": "inset 0 1px 0 hsl(var(--film) / 0.06), 0 12px 28px -12px hsl(0 0% 0% / 0.6)",
        "overlay": "inset 0 1px 0 hsl(var(--film) / 0.07), 0 24px 64px -28px hsl(0 0% 0% / 0.8)",
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
        // Ink levels 3 and 4. Reach for these instead of stacking an opacity
        // modifier on muted-foreground; see the ink ramp note in index.css.
        subtle: { foreground: "hsl(var(--subtle-foreground))" },
        faint: { foreground: "hsl(var(--faint-foreground))" },
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
        "conf-confirmed": "hsl(var(--conf-confirmed))",
        "conf-likely": "hsl(var(--conf-likely))",
        "conf-possible": "hsl(var(--conf-possible))",
        "conf-weak": "hsl(var(--conf-weak))",
        "conf-unverified": "hsl(var(--conf-unverified))",
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

        // ── The film ────────────────────────────────────────────────────
        // `white` is REMAPPED onto the cold film token, and that is the whole
        // point. Every translucent highlight in the product is written in
        // markup as `bg-white/5`, `border-white/10`, `text-white/70` — 84 of
        // them across 17 .tsx files, none token-backed. While `white` stayed
        // pure #fff, a hue-neutral sheet was laid over every surface and
        // cancelled whatever the palette underneath was saying. That is the
        // mechanical reason previous colour passes on this app "changed
        // nothing an analyst sees". Remapping it here means all 84 follow the
        // register automatically, and `text-white` resolves to the brightest
        // ink rather than to a colour that exists nowhere else on screen.
        white: "hsl(var(--film) / <alpha-value>)",
        film: "hsl(var(--film) / <alpha-value>)",

        // Entity-kind taxonomy — the Graph tab's own palette. Documented
        // exception to "hue belongs to authority"; see the :root comment.
        "kind-identity": "hsl(var(--kind-identity))",
        "kind-contact": "hsl(var(--kind-contact))",
        "kind-social": "hsl(var(--kind-social))",
        "kind-infrastructure": "hsl(var(--kind-infrastructure))",
        "kind-breach": "hsl(var(--kind-breach))",
        "kind-web": "hsl(var(--kind-web))",
        "kind-crypto": "hsl(var(--kind-crypto))",
        "kind-other": "hsl(var(--kind-other))",
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
  plugins: [
    tailwindcssAnimate,
    // `coarse:` — touch screens, where controls grow to a 44px target and
    // desktop density is untouched. A variant, NOT a `screens` entry: a raw
    // media query in `screens` silently disables every `max-*` variant
    // (`max-sm:hidden` and friends), which broke the phone composer.
    plugin(({ addVariant }) => addVariant("coarse", "@media (pointer: coarse)")),
  ],
} satisfies Config;
