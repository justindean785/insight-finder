import { Link } from "react-router-dom";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { Search, GitFork, FileCheck } from "lucide-react";

const FEATURES = [
  {
    icon: Search,
    title: "Multi-source intelligence",
    desc: "Seed any identifier — name, email, domain, phone, IP — and the swarm harvests OSINT from dozens of sources simultaneously.",
  },
  {
    icon: GitFork,
    title: "Entity pivots & knowledge graph",
    desc: "Discovered entities become new pivot points. Follow the graph from a single seed to a full intelligence picture.",
  },
  {
    icon: FileCheck,
    title: "Auditable reports",
    desc: "Every finding carries source attribution, confidence scoring, and a chain-of-custody trail you can hand to a stakeholder.",
  },
] as const;

export default function Landing() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center bg-background p-6 overflow-hidden">
      {/* Ambient glow + grid backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 18%, hsl(var(--primary) / 0.18) 0%, transparent 60%), radial-gradient(50% 50% at 80% 95%, hsl(var(--accent) / 0.12) 0%, transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />

      <div className="relative w-full max-w-3xl space-y-16">
        {/* Hero */}
        <div className="text-center space-y-5">
          <div className="relative inline-flex items-center justify-center w-20 h-20 rounded-2xl glass-strong border border-white/10 mx-auto shadow-[0_8px_40px_-12px_hsl(var(--primary)/0.55)]">
            <SwarmMark className="w-12 h-12" />
          </div>
          <div className="space-y-3">
            <h1 className="font-display text-4xl sm:text-5xl leading-none font-semibold tracking-tight gradient-text">
              Swarmbot
            </h1>
            <p className="text-muted-foreground text-base max-w-lg mx-auto">
              Chat-driven OSINT investigator. Seed an identifier, get actionable intelligence, export auditable reports.
            </p>
          </div>
          <div className="flex items-center justify-center gap-3 pt-2">
            <Link
              to="/auth"
              className="rounded-md border border-white/[0.08] bg-transparent px-5 py-2.5 text-sm text-foreground/90 hover:bg-white/[0.04] hover:border-white/[0.14] transition-colors"
            >
              Sign in
            </Link>
            <Link
              to="/auth?tab=signup"
              className="rounded-md bg-gradient-to-r from-primary to-accent px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 shadow-[0_8px_24px_-8px_hsl(var(--primary)/0.6)] transition-opacity"
            >
              Get started
            </Link>
          </div>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="glass-card rounded-2xl border border-white/[0.07] p-6 space-y-3"
            >
              <Icon className="w-5 h-5 text-muted-foreground" strokeWidth={1.5} />
              <h2 className="text-sm font-medium text-foreground">{title}</h2>
              <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>

        {/* Footer */}
        <footer className="text-center text-eyebrow uppercase tracking-[0.16em] text-muted-foreground/60 font-mono">
          <Link to="/terms" className="hover:text-muted-foreground transition-colors">Terms</Link>
          <span className="mx-2">·</span>
          <Link to="/privacy" className="hover:text-muted-foreground transition-colors">Privacy</Link>
        </footer>
      </div>
    </div>
  );
}
