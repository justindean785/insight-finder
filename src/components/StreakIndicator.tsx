import { useEffect, useMemo, useRef, useState } from "react";
import { Flame, Sparkles, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * Tracks recent artifact activity and surfaces a streak/heat indicator
 * when the agent is "on a roll" — many hits in a short window or
 * high-impact findings (breaches, high confidence).
 */

const WINDOW_MS = 90_000; // 90s sliding window

type Heat = {
  level: 0 | 1 | 2 | 3; // none / warm / hot / blazing
  recent: number;
  highImpact: number;
  label: string;
};

function scoreArtifact(a: Artifact): number {
  let s = 1;
  if ((a.confidence ?? 0) >= 0.8) s += 1;
  const kind = a.kind.toLowerCase();
  if (kind === "breach" || kind === "password") s += 2;
  if (kind === "email" || kind === "phone" || kind === "ip") s += 0.5;
  return s;
}

function computeHeat(items: Artifact[]): Heat {
  const now = Date.now();
  const recent = items.filter((a) => now - new Date(a.created_at).getTime() < WINDOW_MS);
  const score = recent.reduce((acc, a) => acc + scoreArtifact(a), 0);
  const highImpact = recent.filter(
    (a) => (a.confidence ?? 0) >= 0.8 || a.kind.toLowerCase() === "breach",
  ).length;

  let level: Heat["level"] = 0;
  let label = "";
  if (score >= 12 || highImpact >= 3) { level = 3; label = "Blazing"; }
  else if (score >= 7 || highImpact >= 2) { level = 2; label = "On fire"; }
  else if (score >= 3) { level = 1; label = "Heating up"; }

  return { level, recent: recent.length, highImpact, label };
}

export function StreakIndicator({ artifacts }: { artifacts: Artifact[] }) {
  // Re-evaluate on a tick so the window slides even without new artifacts.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const heat = useMemo(() => computeHeat(artifacts), [artifacts, tick]);

  // Pulse on every new artifact
  const lastCount = useRef(artifacts.length);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (artifacts.length > lastCount.current) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 700);
      lastCount.current = artifacts.length;
      return () => clearTimeout(t);
    }
    lastCount.current = artifacts.length;
  }, [artifacts.length]);

  if (heat.level === 0) return null;

  const Icon = heat.level === 3 ? Flame : heat.level === 2 ? Zap : Sparkles;

  const tone =
    heat.level === 3
      ? "border-warning/50 text-warning bg-warning/10"
      : heat.level === 2
      ? "border-primary/50 text-primary bg-primary/10"
      : "border-highconf/40 text-highconf bg-highconf/10";

  return (
    <div
      className={cn(
        "relative shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-eyebrow font-mono uppercase tracking-wider overflow-hidden",
        tone,
        pulse && "animate-pulse-ring",
      )}
      title={`${heat.recent} hits in last 90s${heat.highImpact ? ` · ${heat.highImpact} high-impact` : ""}`}
    >
      {/* shimmer sweep on hot/blazing */}
      {heat.level >= 2 && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-shimmer opacity-60"
        />
      )}
      <Icon
        className={cn(
          "w-3 h-3 relative",
          heat.level === 3 && "animate-float-slow",
          heat.level === 2 && "animate-pulse",
        )}
      />
      <span className="relative font-semibold">{heat.label}</span>
      <span className="relative opacity-70">×{heat.recent}</span>
    </div>
  );
}
