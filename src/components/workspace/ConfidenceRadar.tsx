import { useMemo } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewAdjustment } from "@/lib/intel";
import { buildConfidenceProfile, DIMENSION_DEFINITIONS, type ConfidenceDimension } from "@/lib/confidence-dimensions";
import { Radar, Info, ShieldCheck, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { confidenceColor, tierInfo } from "@/lib/confidence-tier";

/** Value → tier colour (the one shared confidence ramp). Insufficient axes read
 *  as the neutral "unverified" slate rather than implying a low score. */
function bandColor(d: ConfidenceDimension): string {
  if (!d.sufficient) return "hsl(var(--conf-unverified))";
  return confidenceColor(d.value);
}

// Plot radius kept well inside the viewBox so axis labels (e.g. "Corroboration")
// have a gutter and never clip — the old R=92 in a 260-wide box ran long labels
// off the edge.
const R = 62;
const CX = 140;
const CY = 116;

function pointAt(i: number, n: number, frac: number): [number, number] {
  const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
  return [CX + Math.cos(angle) * R * frac, CY + Math.sin(angle) * R * frac];
}

/**
 * Confidence radar — a restrained, honest visual summary of the evidence
 * SIGNALS behind a case (identity, selectors, corroboration, source diversity,
 * recency, conflict-free, report readiness). It is explicitly NOT a certainty
 * score: each axis carries a reason, thin data reads as "insufficient", and the
 * accessible dimension list below carries the same values/reasons for
 * screen-reader and mobile users (no reliance on the SVG alone).
 */
export function ConfidenceRadar({
  artifacts,
  seedValue,
  reviews,
}: {
  artifacts: Artifact[];
  seedValue: string | null;
  reviews?: Record<string, ReviewAdjustment>;
}) {
  const profile = useMemo(
    () => buildConfidenceProfile({ artifacts, seedValue, reviews }),
    [artifacts, seedValue, reviews],
  );

  const dims = profile.dimensions;
  const n = dims.length;

  const polygon = dims.map((d, i) => pointAt(i, n, d.value / 100).join(",")).join(" ");
  const a11ySummary = `Confidence signals — overall ${profile.overall} percent. ` +
    dims.map((d) => `${d.label} ${d.sufficient ? `${d.value} percent` : "insufficient data"}`).join(", ") + ".";

  return (
    <section className="rounded-lg border border-border-subtle bg-surface-1 p-3" aria-label="Confidence signals">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Radar className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
          <h3 className="text-meta font-semibold text-foreground leading-none">Confidence signals</h3>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-eyebrow font-mono uppercase tracking-wider",
            profile.reportReady
              ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10"
              : "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
          )}
          title={profile.reportReady ? "Verified/corroborated base with conflicts under control" : "Not enough verified/corroborated evidence to be report-safe"}
        >
          {profile.reportReady ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
          {profile.reportReady ? "Report-ready" : "Needs review"}
        </span>
      </div>

      <p className="mt-1.5 text-data text-muted-foreground/80 leading-relaxed flex items-start gap-1.5">
        <Info className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
        A summary of available evidence signals, not a certainty score. Each axis is explained below; thin data reads as
        insufficient rather than implying precision.
      </p>

      {profile.limited && (
        <p className="mt-2 rounded-md border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-data text-muted-foreground">
          Not enough evidence for a confidence chart yet — these axes are preliminary and will sharpen as the case grows.
        </p>
      )}

      <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,260px)_1fr] items-center">
        {/* Radar (decorative; the list below is the accessible source of truth). */}
        <svg viewBox="0 0 280 236" className="w-full max-w-[280px] mx-auto" role="img" aria-label={a11ySummary} preserveAspectRatio="xMidYMid meet">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <polygon
              key={f}
              points={dims.map((_, i) => pointAt(i, n, f).join(",")).join(" ")}
              fill="none"
              stroke="hsl(var(--border-subtle))"
              strokeWidth={1}
            />
          ))}
          {dims.map((d, i) => {
            const [ex, ey] = pointAt(i, n, 1);
            const [lx, ly] = pointAt(i, n, 1.24);
            const anchor = Math.abs(lx - CX) < 8 ? "middle" : lx > CX ? "start" : "end";
            return (
              <g key={d.key}>
                <line x1={CX} y1={CY} x2={ex} y2={ey} stroke="hsl(var(--border-subtle))" strokeWidth={1} />
                <text x={lx} y={ly} textAnchor={anchor} dominantBaseline="middle" fontSize={9} className="font-mono" fill="hsl(var(--muted-foreground))">
                  <title>{DIMENSION_DEFINITIONS[d.key] ?? d.reason}</title>
                  {d.label}
                </text>
              </g>
            );
          })}
          {/* Polygon tinted by the OVERALL tier so the shape's colour matches the
              headline read; vertices below carry each axis's own tier colour. */}
          <polygon
            points={polygon}
            style={{ fill: `hsl(var(${tierInfo(profile.overall).varName}) / 0.14)` }}
            stroke={confidenceColor(profile.overall)}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          {dims.map((d, i) => {
            const [px, py] = pointAt(i, n, d.value / 100);
            return <circle key={d.key} cx={px} cy={py} r={2.4} fill={bandColor(d)} />;
          })}
        </svg>

        {/* Accessible dimension list — readable values + reasons, mobile-safe. */}
        <ul className="space-y-1.5">
          {dims.map((d) => (
            <li key={d.key} className="text-data">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-foreground decoration-dotted decoration-muted-foreground/50 underline-offset-2 [text-decoration-line:underline] cursor-help"
                  title={DIMENSION_DEFINITIONS[d.key] ?? d.reason}
                >
                  {d.label}
                </span>
                <span className="font-mono tabular-nums" style={{ color: bandColor(d) }}>
                  {d.sufficient ? `${d.value}%` : "—"}
                </span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-surface-3 overflow-hidden" aria-hidden>
                <div className="h-full rounded-full" style={{ width: `${d.sufficient ? d.value : 0}%`, backgroundColor: bandColor(d) }} />
              </div>
              <p className="mt-0.5 text-eyebrow leading-snug text-muted-foreground/80">
                {!d.sufficient && <span className="text-muted-foreground">Insufficient data — </span>}
                {d.reason}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
