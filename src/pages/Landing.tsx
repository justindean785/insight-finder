import { Link } from "react-router-dom";
import { SwarmMark } from "@/components/ui/swarm-mark";
import {
  ArrowRight,
  FileCheck,
  GitFork,
  Search,
  ScanLine,
  ShieldAlert,
  Layers,
} from "lucide-react";

const WORKFLOW = [
  {
    step: "01",
    icon: Search,
    title: "Acquire with context",
    desc: "Start from a real selector and keep each finding connected to its originating source.",
  },
  {
    step: "02",
    icon: GitFork,
    title: "Corroborate the graph",
    desc: "Pivot across related entities while preserving uncertainty, conflicts, and review state.",
  },
  {
    step: "03",
    icon: FileCheck,
    title: "Brief with evidence",
    desc: "Turn reviewed findings into an auditable intelligence record built for stakeholder scrutiny.",
  },
] as const;

/* The authority ladder, rendered in the product's own tokens. Showing the real
   colour language on the marketing surface is the point: an evidence tool is
   credible in proportion to how precisely it can say how sure it is. */
const LADDER = [
  { label: "Verified", token: "--authority-verified", note: "two independent sources" },
  { label: "Infrastructure", token: "--authority-infrastructure", note: "resolves, not owned" },
  { label: "Review", token: "--authority-review", note: "single source" },
  { label: "Conflict", token: "--authority-conflict", note: "contradicted" },
  { label: "Quarantined", token: "--authority-quarantine", note: "not linked to subject" },
] as const;

const PRINCIPLES = [
  {
    icon: Layers,
    title: "Every source is classified",
    desc: "Authoritative, provider, broker, and mirrored records are separated before they are counted — so two copies of one leak never read as corroboration.",
  },
  {
    icon: ScanLine,
    title: "Confidence is computed, not asserted",
    desc: "Independence is derived server-side and the resulting score is capped at the write layer. A finding cannot argue itself upward.",
  },
  {
    icon: ShieldAlert,
    title: "Quarantine is disclosure, not deletion",
    desc: "A selector that cannot be linked to the subject keeps its row, its reason, and its place in the evidence count — it simply loses its authority.",
  },
] as const;

export default function Landing() {
  return (
    <div className="ops-shell relative min-h-screen overflow-hidden bg-background text-foreground">
      <div aria-hidden className="ops-grid pointer-events-none absolute inset-0 opacity-70" />
      <div
        aria-hidden
        className="hero-field pointer-events-none absolute inset-x-0 top-0 h-[820px] opacity-90"
      />

      {/* Status rail — the instrument announces itself before the copy does. */}
      <div
        aria-hidden
        className="relative flex items-center justify-between border-b border-white/[0.07] px-5 py-2 font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70 sm:px-8 lg:px-10"
      >
        <span className="inline-flex items-center gap-2">
          <span className="live-dot h-1.5 w-1.5" />
          System operational
        </span>
        {/* The product's three standing commitments. Pinned by
            src/test/ui-command-center-contract.test.ts — they are a contract,
            not decoration, so keep the exact words if this rail is restyled. */}
        <span className="hidden sm:inline">Source-aware · Human-controlled · Audit-ready</span>
        <span>IF / OPS</span>
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-col px-5 py-5 sm:px-8 sm:py-7 lg:px-10">
        <header className="flex items-center justify-between border-b border-white/[0.08] pb-5">
          <Link
            to="/"
            aria-label="Insight Finder home"
            className="group flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="brand-tile h-10 w-10">
              <SwarmMark className="h-6 w-6 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]" glow={false} />
            </span>
            <span>
              <span className="block font-display text-sm font-semibold tracking-tight">Insight Finder</span>
              <span className="block font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground">
                Analyst workspace
              </span>
            </span>
          </Link>

          <div className="flex items-center gap-2.5">
            <Link
              to="/auth"
              className="rounded-lg border border-white/[0.1] bg-white/[0.035] px-3.5 py-2 text-xs font-medium text-foreground/90 transition-colors hover:border-white/[0.16] hover:bg-white/[0.065] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Operator sign in
            </Link>
          </div>
        </header>

        <main className="grid items-start gap-12 py-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(380px,0.8fr)] lg:gap-16 lg:py-16">
          <section className="max-w-3xl">
            <div className="inline-flex items-center gap-2.5 rounded-full border border-[hsl(var(--intel-blue)/0.32)] bg-[hsl(var(--intel-blue)/0.08)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[hsl(var(--intel-blue))]">
              <span className="live-dot h-1.5 w-1.5" aria-hidden />
              Evidence-led OSINT operations
            </div>

            <h1 className="mt-7 max-w-3xl font-display text-5xl font-semibold leading-[0.96] tracking-[-0.045em] sm:text-6xl lg:text-[4.75rem]">
              From open-source signals to{" "}
              <span className="gradient-text">defensible intelligence.</span>
            </h1>

            <p className="mt-7 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
              Investigate selectors, trace entity relationships, and assemble source-aware findings
              in one focused workspace. Every conclusion stays connected to the evidence behind it.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/auth?tab=signup"
                className="group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-cta transition-[transform,box-shadow] hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Enter the workspace
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/auth"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-white/[0.12] bg-white/[0.035] px-5 text-sm font-medium text-foreground transition-colors hover:border-[hsl(var(--brand)/0.4)] hover:bg-white/[0.065] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Sign in to an existing account
              </Link>
            </div>

            {/* The authority ladder as a credibility strip — the product's own
                spine element, at the product's own tokens. */}
            <div className="mt-10 border-t border-white/[0.08] pt-6">
              <p className="label-eyebrow">Every finding lands on a rung</p>
              <ul className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
                {LADDER.map(({ label, token, note }) => (
                  <li key={label} className="flex items-start gap-2.5">
                    <span
                      aria-hidden
                      className="mt-0.5 h-8 w-[3px] shrink-0 rounded-full"
                      style={{
                        background: `hsl(var(${token}))`,
                        boxShadow: `0 0 10px hsl(var(${token}) / 0.55)`,
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold tracking-tight text-foreground">
                        {label}
                      </span>
                      <span className="mt-1 block font-mono text-[9px] uppercase leading-4 tracking-[0.12em] text-muted-foreground/70">
                        {note}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <aside className="instrument-panel blueprint-ticks relative overflow-hidden rounded-3xl border border-white/[0.1] bg-[linear-gradient(155deg,hsl(var(--film)/0.07),hsl(var(--film)/0.018)_56%,hsl(var(--film)/0.03))] p-5 shadow-[0_34px_100px_-48px_rgba(0,0,0,0.95)] sm:p-7">
            <div aria-hidden className="signal-sweep absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--intel-blue))] to-transparent opacity-70" />
            <div className="flex items-start justify-between gap-6 border-b border-white/[0.08] pb-5">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.24em] text-[hsl(var(--intel-blue))]">
                  Operational workflow
                </p>
                <h2 className="mt-2 font-display text-xl font-semibold tracking-tight">
                  Intelligence with a review trail
                </h2>
              </div>
              <span className="rounded-md border border-white/[0.1] bg-black/20 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                IF / OPS
              </span>
            </div>

            <ol className="mt-2 divide-y divide-white/[0.07]">
              {WORKFLOW.map(({ step, icon: Icon, title, desc }) => (
                <li key={step} className="relative grid grid-cols-[auto_1fr] gap-4 py-5">
                  {/* Connecting spine — the steps are one run, not three cards. */}
                  <span
                    aria-hidden
                    className="absolute left-[18px] top-14 h-[calc(100%-3rem)] w-px bg-gradient-to-b from-[hsl(var(--brand)/0.4)] to-transparent last:hidden"
                  />
                  <div className="flex flex-col items-center gap-2">
                    <span className="font-mono text-[9px] tracking-[0.18em] text-[hsl(var(--intel-blue)/0.85)]">
                      {step}
                    </span>
                    <span className="grid h-9 w-9 place-items-center rounded-lg border border-[hsl(var(--brand)/0.22)] bg-[hsl(var(--brand)/0.09)] shadow-[inset_0_1px_0_hsl(var(--film)/0.08)]">
                      <Icon className="h-4 w-4 text-[hsl(var(--intel-blue))]" strokeWidth={1.5} />
                    </span>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{desc}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-1 flex items-center justify-between border-t border-white/[0.08] pt-4 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">
              <span className="inline-flex items-center gap-2">
                <span className="live-dot h-1.5 w-1.5" aria-hidden />
                Chain of custody retained
              </span>
              <span>03 / 03</span>
            </div>
          </aside>
        </main>

        {/* Integrity band — what the product refuses to do is the product. */}
        <section aria-labelledby="principles-heading" className="border-t border-white/[0.08] py-12 lg:py-14">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="principles-heading" className="label-eyebrow">
              Built to survive scrutiny
            </h2>
            <p className="max-w-xl text-xs leading-5 text-muted-foreground/80">
              The controls below are enforced where the data is written, not where it is displayed.
            </p>
          </div>
          <div className="mt-7 grid gap-4 md:grid-cols-3">
            {PRINCIPLES.map(({ icon: Icon, title, desc }, i) => (
              <article
                key={title}
                className="group relative overflow-hidden rounded-2xl border border-white/[0.09] bg-[linear-gradient(165deg,hsl(var(--film)/0.05),hsl(var(--film)/0.012))] p-5 shadow-[0_20px_60px_-42px_rgba(0,0,0,0.9)] transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-[hsl(var(--brand)/0.3)]"
              >
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--brand)/0.55)] to-transparent opacity-40 transition-opacity group-hover:opacity-100"
                />
                <div className="flex items-center justify-between">
                  <span className="grid h-9 w-9 place-items-center rounded-lg border border-[hsl(var(--brand)/0.2)] bg-[hsl(var(--brand)/0.08)]">
                    <Icon className="h-4 w-4 text-[hsl(var(--intel-blue))]" strokeWidth={1.5} />
                  </span>
                  <span aria-hidden className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground/45">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-4 text-sm font-semibold tracking-tight text-foreground">{title}</h3>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{desc}</p>
              </article>
            ))}
          </div>
        </section>

        <div aria-hidden className="signal-rule" />

        <footer className="flex flex-col gap-3 pt-5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/65 sm:flex-row sm:items-center sm:justify-between">
          <span>Built for source-aware investigation</span>
          <span>
            <Link to="/terms" className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Terms
            </Link>
            <span className="mx-2" aria-hidden>·</span>
            <Link to="/privacy" className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Privacy
            </Link>
          </span>
        </footer>
      </div>
    </div>
  );
}
