import { useId, useMemo } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewAdjustment } from "@/lib/intel";
import { buildConfidenceProfile, DIMENSION_DEFINITIONS, type ConfidenceDimension, type ConfidenceProfile } from "@/lib/confidence-dimensions";
import { Radar, Info, ShieldCheck, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { confidenceColor, tierInfo } from "@/lib/confidence-tier";

/** Value → tier colour (the one shared confidence ramp). Insufficient axes read
 *  as the neutral "unverified" slate rather than implying a low score. */
function bandColor(d: ConfidenceDimension): string {
  if (!d.sufficient) return "hsl(var(--conf-unverified))";
  return confidenceColor(d.value);
}

// Plot radius kept well inside the viewBox, AND the viewBox is padded on the
// left/right (see the negative x-origin below) so the long axis labels
// ("Corroboration" on the right, "Conflict-free" / "Report readiness" on the
// left) have a real gutter and never clip their first/last letter.
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
  profile: given,
}: {
  artifacts: Artifact[];
  seedValue: string | null;
  reviews?: Record<string, ReviewAdjustment>;
  /** The case snapshot's profile — the same version every other figure reads.
   *  Computed here only when the radar is rendered standalone. */
  profile?: ConfidenceProfile;
}) {
  const computed = useMemo(
    () => (given ? null : buildConfidenceProfile({ artifacts, seedValue, reviews })),
    [given, artifacts, seedValue, reviews],
  );
  const profile = given ?? computed!;

  const dims = profile.dimensions;
  const n = dims.length;
  // React's useId embeds ":" which is not safe inside an SVG url(#…) reference.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tierVar = tierInfo(profile.overall).varName;

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
        <svg viewBox="-26 0 332 236" className="hidden w-full max-w-[300px] mx-auto overflow-visible sm:block" role="img" aria-label={a11ySummary} preserveAspectRatio="xMidYMid meet">
          <defs>
            {/* The plot is filled with a GRADIENT of the tier token rather than
                a flat alpha. A single-alpha polygon on a dark ground reads as a
                smudge; grading it top-to-bottom gives the shape a lit face and
                a shaded foot, which is what makes it look like an object.
                The tier still selects the token — this changes rendering only,
                never which colour a confidence maps to. */}
            <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`hsl(var(${tierVar}))`} stopOpacity={0.44} />
              <stop offset="100%" stopColor={`hsl(var(${tierVar}))`} stopOpacity={0.13} />
            </linearGradient>
            {/* A soft bloom under the stroke so the plot sits above the web. */}
            <filter id={`${uid}-glow`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <radialGradient id={`${uid}-ground`}>
              <stop offset="0%" stopColor="hsl(var(--film))" stopOpacity={0.05} />
              <stop offset="100%" stopColor="hsl(var(--film))" stopOpacity={0} />
            </radialGradient>
          </defs>

          {/* Ground — grounds the web so it does not float on flat black. */}
          <circle cx={CX} cy={CY} r={R * 1.12} fill={`url(#${uid}-ground)`} />

          {/* Graduated rings: the outer ring is the measured extent and reads
              brightest; inner rings fall away. Four identical hairlines gave the
              web no depth at all. */}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <polygon
              key={f}
              points={dims.map((_, i) => pointAt(i, n, f).join(",")).join(" ")}
              fill="none"
              stroke="hsl(var(--film))"
              strokeOpacity={0.05 + f * 0.075}
              strokeWidth={f === 1 ? 1.25 : 1}
            />
          ))}
          {dims.map((d, i) => {
            const [ex, ey] = pointAt(i, n, 1);
            const [lx, ly] = pointAt(i, n, 1.24);
            const anchor = Math.abs(lx - CX) < 8 ? "middle" : lx > CX ? "start" : "end";
            return (
              <g key={d.key}>
                <line x1={CX} y1={CY} x2={ex} y2={ey} stroke="hsl(var(--film))" strokeOpacity={0.07} strokeWidth={1} />
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
            // Contrast, not colour. Once confidence stopped being carried by
            // hue, a 14%-alpha fill of a low-chroma token on true black left
            // the shape unreadable — the plot became a faint smudge while the
            // numbers beside it stayed perfectly legible, which is the wrong
            // way round for a chart. Raised fill and a full-strength stroke;
            // the tier still selects the token, it is just actually visible.
            fill={`url(#${uid}-fill)`}
            stroke={confidenceColor(profile.overall)}
            strokeWidth={2}
            strokeLinejoin="round"
            filter={`url(#${uid}-glow)`}
          />
          {dims.map((d, i) => {
            const [px, py] = pointAt(i, n, d.value / 100);
            return (
              <circle
                key={d.key}
                cx={px}
                cy={py}
                r={3}
                fill={bandColor(d)}
                /* A ring of the ground colour separates the vertex from the
                   fill it sits on; without it the dots dissolve into the plot. */
                stroke="hsl(var(--surface-0))"
                strokeWidth={1.25}
              />
            );
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
              {/* A LOW value and NO value must not look the same. At 1px on a
                  barely-tinted track, 17% rendered as an empty bar — the same
                  picture an insufficient axis draws, when the two mean opposite
                  things (measured-and-weak vs not-measurable). Taller bar, a
                  track you can actually see, and a floor so any non-zero value
                  leaves a visible mark. */}
              <div className="mt-1 h-1.5 rounded-full bg-[hsl(var(--film)/0.1)] overflow-hidden" aria-hidden>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: d.sufficient ? `${Math.max(2.5, d.value)}%` : "0%",
                    backgroundColor: bandColor(d),
                  }}
                />
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
