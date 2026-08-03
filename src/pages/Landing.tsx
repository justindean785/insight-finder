import { Link } from "react-router-dom";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { ArrowRight, CheckCircle2, FileCheck, GitFork, Search } from "lucide-react";

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

export default function Landing() {
  return (
    <div className="ops-shell relative min-h-screen overflow-hidden bg-background text-foreground">
      <div aria-hidden className="ops-grid pointer-events-none absolute inset-0 opacity-70" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 65% at 15% 20%, hsl(var(--intel-blue) / 0.18) 0%, transparent 58%), radial-gradient(45% 50% at 88% 88%, hsl(var(--primary) / 0.1) 0%, transparent 64%)",
        }}
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-5 sm:px-8 sm:py-7 lg:px-10">
        <header className="flex items-center justify-between border-b border-white/[0.08] pb-5">
          <Link
            to="/"
            aria-label="Insight Finder home"
            className="group flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.12] bg-white/[0.045] shadow-cta">
              <SwarmMark className="h-6 w-6" />
            </span>
            <span>
              <span className="block font-display text-sm font-semibold tracking-tight">Insight Finder</span>
              <span className="block font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground">
                Analyst workspace
              </span>
            </span>
          </Link>

          <Link
            to="/auth"
            className="rounded-lg border border-white/[0.1] bg-white/[0.035] px-3.5 py-2 text-xs font-medium text-foreground/90 transition-colors hover:border-white/[0.16] hover:bg-white/[0.065] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Operator sign in
          </Link>
        </header>

        <main className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.75fr)] lg:gap-16 lg:py-16">
          <section className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-[hsl(var(--intel-blue)/0.3)] bg-[hsl(var(--intel-blue)/0.08)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[hsl(var(--intel-blue))]">
              <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--intel-blue))] shadow-[0_0_10px_hsl(var(--intel-blue)/0.8)]" aria-hidden />
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
                className="group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-black shadow-cta transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Enter the workspace
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/auth"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-white/[0.12] bg-white/[0.035] px-5 text-sm font-medium text-foreground transition-colors hover:border-white/[0.18] hover:bg-white/[0.065] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Sign in to an existing account
              </Link>
            </div>

            <div className="mt-9 flex flex-wrap gap-x-6 gap-y-3 border-t border-white/[0.08] pt-6">
              {["Source-aware", "Human-controlled", "Audit-ready"].map((item) => (
                <span key={item} className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--intel-blue))]" />
                  {item}
                </span>
              ))}
            </div>
          </section>

          <aside className="instrument-panel relative overflow-hidden rounded-3xl border border-white/[0.1] bg-[linear-gradient(155deg,rgba(255,255,255,0.07),rgba(255,255,255,0.018)_56%,rgba(255,255,255,0.03))] p-5 shadow-[0_34px_100px_-48px_rgba(0,0,0,0.95)] sm:p-7">
            <div aria-hidden className="signal-sweep absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--intel-blue))] to-transparent opacity-60" />
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
                <li key={step} className="grid grid-cols-[auto_1fr] gap-4 py-5">
                  <div className="flex flex-col items-center gap-2">
                    <span className="font-mono text-[9px] tracking-[0.18em] text-muted-foreground">{step}</span>
                    <span className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.1] bg-white/[0.04]">
                      <Icon className="h-4 w-4 text-foreground/80" strokeWidth={1.5} />
                    </span>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{desc}</p>
                  </div>
                </li>
              ))}
            </ol>
          </aside>
        </main>

        <footer className="flex flex-col gap-3 border-t border-white/[0.08] pt-5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/65 sm:flex-row sm:items-center sm:justify-between">
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
