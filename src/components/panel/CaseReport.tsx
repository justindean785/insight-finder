import { useMemo } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  labelForArtifact,
  adjustedConfidence,
  buildIdentityClusters,
  buildToolAudit,
  inferToolGaps,
  groupForKind,
  GROUP_LABEL,
  displayKind,
  isReputationArtifact,
  type ConfLabel,
} from "@/lib/intel";
import { REVIEW_SHORT, REVIEW_CLASS, type ReviewState } from "@/lib/review";
import { toolActionLabel } from "@/lib/tool-display";
import { cn } from "@/lib/utils";

/** Analyst review lookup — `new` (unreviewed) when absent. */
type ReviewMap = Record<string, ReviewState>;
const reviewOf = (reviews: ReviewMap | undefined, id: string): ReviewState => reviews?.[id] ?? "new";

/* ------------------------------------------------------------------ */
/* Evidence-strength bucketing                                         */
/* ------------------------------------------------------------------ */

function statusOf(a: Artifact): string {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return String((m.status as string) ?? "new");
}
function bucket(
  a: Artifact,
  review: ReviewState = "new",
): "confirmed" | "probable" | "lead" | "contradiction" | "excluded" {
  // Analyst review wins over the source-derived status — a human verdict is the
  // strongest signal we have. Verified/key promote; dismissed/wrong exclude.
  if (review === "dismissed" || review === "wrong") return "excluded";
  if (review === "confirmed" || review === "key") return "confirmed";
  const c = adjustedConfidence(a, review);
  const st = statusOf(a);
  if (a.kind.toLowerCase() === "contradiction" || st === "contradicted") return "contradiction";
  if (st === "excluded" || a.kind.toLowerCase() === "excluded_collision") return "excluded";
  if (st === "verified" || c >= 90) return "confirmed";
  if (st === "probable" || c >= 75) return "probable";
  return "lead";
}

/** Color-coded confidence meter — number alone reads as noise across 40 rows. */
function ConfMeter({ value }: { value: number | null }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const tone =
    value == null ? "muted-foreground"
    : v >= 70 ? "confidence-high"
    : v >= 40 ? "confidence-mid"
    : "danger";
  return (
    <div className="flex items-center gap-2 min-w-[84px]">
      <div className="relative h-1.5 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${v}%`, backgroundColor: `hsl(var(--${tone}))` }} />
      </div>
      <span className="font-mono tabular-nums text-[11px] w-7 text-right" style={{ color: `hsl(var(--${tone}))` }}>
        {value ?? "—"}
      </span>
    </div>
  );
}

/** Analyst verdict pill — the marks that previously never reached the report. */
function ReviewPill({ review }: { review: ReviewState }) {
  if (review === "new") return <span className="text-muted-foreground/50 text-[11px]">—</span>;
  return (
    <span className={cn("inline-block px-1.5 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wide", REVIEW_CLASS[review])}>
      {REVIEW_SHORT[review]}
    </span>
  );
}

function ArtifactRow({ a, review }: { a: Artifact; review: ReviewState }) {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const reviewed = review !== "new";
  return (
    <tr className="border-t border-border-subtle align-top">
      <td className="px-3 py-2.5"><ReviewPill review={review} /></td>
      <td className="px-3 py-2.5 text-muted-foreground text-eyebrow uppercase tracking-wider">{displayKind(a)}</td>
      <td className="px-3 py-2.5 font-mono break-all">{a.value}</td>
      <td className="px-3 py-2.5 text-data text-muted-foreground">{a.source ?? "—"}</td>
      <td className="px-3 py-2.5"><ConfMeter value={reviewed ? adjustedConfidence(a, review) : a.confidence} /></td>
      <td className="px-3 py-2.5 text-data text-muted-foreground/90 leading-relaxed min-w-[180px]">
        {reviewed
          ? <span className="text-foreground/80">Analyst {REVIEW_SHORT[review].toLowerCase()} (review-adjusted)</span>
          : String((m.reason_for_confidence as string) ?? "")}
        {m.reason_not_confirmed && !reviewed ? <div className="text-destructive mt-0.5">{String(m.reason_not_confirmed)}</div> : null}
      </td>
    </tr>
  );
}

function BucketTable({ rows, empty, reviews }: { rows: Artifact[]; empty: string; reviews?: ReviewMap }) {
  if (!rows.length) return <p className="text-muted-foreground italic text-data mt-2">{empty}</p>;
  return (
    <div className="rounded-md border border-border-subtle overflow-x-auto mt-2 [scrollbar-width:thin]">
      <table className="w-full min-w-[640px] text-data">
        <thead>
          <tr className="bg-surface-2 text-eyebrow uppercase tracking-[0.15em] text-muted-foreground">
            <th className="text-left font-normal px-3 py-2 w-[72px]">Review</th>
            <th className="text-left font-normal px-3 py-2 w-[100px]">Kind</th>
            <th className="text-left font-normal px-3 py-2">Value</th>
            <th className="text-left font-normal px-3 py-2 w-[130px]">Source</th>
            <th className="text-left font-normal px-3 py-2 w-[120px]">Confidence</th>
            <th className="text-left font-normal px-3 py-2">Reasoning</th>
          </tr>
        </thead>
        <tbody>{rows.map((a) => <ArtifactRow key={a.id} a={a} review={reviewOf(reviews, a.id)} />)}</tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section header — red bar + ALL-CAPS spaced title, like the ref UI. */
/* ------------------------------------------------------------------ */
function SectionHeader({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "danger" }) {
  // Red is reserved for genuine risk sections (safety, contradictions); every
  // other section uses a calm neutral header so the report doesn't read as a
  // wall of warnings.
  const danger = tone === "danger";
  return (
    <div className="flex items-center gap-2 mt-6 mb-3">
      <span className={cn("w-[3px] h-4 rounded-sm", danger ? "bg-destructive" : "bg-foreground/25")} />
      <h3 className={cn("text-eyebrow font-semibold uppercase tracking-[0.18em]", danger ? "text-destructive" : "text-foreground/80")}>
        {children}
      </h3>
    </div>
  );
}

function HunterNote({ children }: { children: React.ReactNode }) {
  return (
    <aside className="my-3 pl-3 border-l-2 border-destructive/80 text-foreground/90 leading-relaxed">
      <div className="text-eyebrow font-semibold tracking-[0.2em] uppercase text-destructive mb-1">
        Hunter's Note
      </div>
      <div className="text-data">{children}</div>
    </aside>
  );
}

const CONF_PILL: Record<ConfLabel, string> = {
  CONFIRMED: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40",
  CORRELATED: "text-[hsl(var(--confidence-high))]/90 border-[hsl(var(--confidence-high))]/30",
  INFERRED: "text-primary border-primary/40",
  VERIFY: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40",
  CONFLICT: "text-destructive border-destructive/40",
  LOW: "text-muted-foreground border-border",
  FAILED: "text-destructive border-destructive/40 line-through",
};

// Map our internal labels to the reference vocabulary
const CONF_DISPLAY: Record<ConfLabel, string> = {
  CONFIRMED: "CONFIRMED",
  CORRELATED: "HIGH",
  INFERRED: "MEDIUM",
  VERIFY: "VERIFY",
  CONFLICT: "CONFLICT",
  LOW: "LOW",
  FAILED: "FAILED",
};

function ConfPill({ label }: { label: ConfLabel }) {
  return (
    <span
      className={cn(
        "inline-block px-2 py-0.5 rounded border text-eyebrow font-mono uppercase tracking-wider",
        CONF_PILL[label],
      )}
    >
      {CONF_DISPLAY[label]}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Derivations                                                         */
/* ------------------------------------------------------------------ */

type IdentityRow = { field: string; value: string; label: ConfLabel };

function pickBest(artifacts: Artifact[], kinds: string[], reviews?: ReviewMap): Artifact | null {
  const pool = artifacts.filter((a) => kinds.includes(a.kind.toLowerCase()));
  if (!pool.length) return null;
  const rank: Record<ConfLabel, number> = {
    CONFIRMED: 6, CORRELATED: 5, INFERRED: 4, VERIFY: 3, LOW: 2, CONFLICT: 1, FAILED: 0,
  };
  return pool.slice().sort((a, b) => {
    const ra = rank[labelForArtifact(a, reviewOf(reviews, a.id))] ?? 0;
    const rb = rank[labelForArtifact(b, reviewOf(reviews, b.id))] ?? 0;
    if (ra !== rb) return rb - ra;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  })[0];
}

function pickAllEmails(artifacts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const a of artifacts.filter((x) => x.kind.toLowerCase() === "email")) {
    const k = a.value.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function buildIdentityRows(artifacts: Artifact[], reviews?: ReviewMap): IdentityRow[] {
  const rows: IdentityRow[] = [];
  const lbl = (a: Artifact) => labelForArtifact(a, reviewOf(reviews, a.id));
  const name = pickBest(artifacts, ["name", "person"], reviews);
  if (name) rows.push({ field: "Real name", value: name.value, label: lbl(name) });

  const dob = pickBest(artifacts, ["dob"], reviews);
  if (dob) rows.push({ field: "Date of birth", value: dob.value, label: lbl(dob) });

  const age = pickBest(artifacts, ["age"], reviews);
  if (age && !dob) rows.push({ field: "Age", value: age.value, label: lbl(age) });

  const phone = pickBest(artifacts, ["phone"], reviews);
  if (phone) rows.push({ field: "Phone", value: phone.value, label: lbl(phone) });

  const region = pickBest(artifacts, ["location", "geo", "address"], reviews);
  if (region) rows.push({ field: "Likely region", value: region.value, label: lbl(region) });

  const emails = pickAllEmails(artifacts);
  emails.forEach((e, i) => {
    rows.push({
      field: i === 0 ? "Primary email" : i === 1 ? "Alt email" : `Email ${i + 1}`,
      value: e.value,
      label: lbl(e),
    });
  });

  const gender = pickBest(artifacts, ["gender"], reviews);
  if (gender) rows.push({ field: "Gender (implied)", value: gender.value, label: lbl(gender) });

  return rows;
}

type RegistrationRow = {
  site: string;
  identifier: string;
  source: string;
  label: ConfLabel;
};

function buildRegistrationRows(artifacts: Artifact[], reviews?: ReviewMap): RegistrationRow[] {
  const rows: RegistrationRow[] = [];
  for (const a of artifacts) {
    const k = a.kind.toLowerCase();
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const site =
      (meta.site as string) ||
      (meta.platform as string) ||
      (meta.service as string) ||
      (meta.source_name as string) ||
      null;
    if (k === "breach" && !isReputationArtifact(a)) {
      rows.push({
        site: site || a.value,
        identifier:
          (meta.identifier as string) ||
          (meta.email as string) ||
          (meta.username as string) ||
          (meta.account as string) ||
          "—",
        source: a.source ?? "—",
        label: labelForArtifact(a, reviewOf(reviews, a.id)),
      });
    } else if ((k === "account" || k === "social" || k === "handle") && site) {
      rows.push({
        site,
        identifier: a.value,
        source: a.source ?? "—",
        label: labelForArtifact(a, reviewOf(reviews, a.id)),
      });
    }
  }
  // Dedupe by site|identifier
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.site.toLowerCase()}|${r.identifier.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type HunterNoteItem = { text: string };

function buildHunterNotes(artifacts: Artifact[], seedValue: string | null): HunterNoteItem[] {
  const notes: HunterNoteItem[] = [];
  const cluster = buildIdentityClusters(artifacts, seedValue);
  for (const w of cluster.warnings.slice(0, 3)) notes.push({ text: w });

  const breaches = artifacts.filter((a) => a.kind.toLowerCase() === "breach");
  const passwords = artifacts.filter((a) => a.kind.toLowerCase() === "password");
  if (breaches.length >= 3) {
    notes.push({
      text: `Subject appears in ${breaches.length} distinct breach corpora. Assume credential exposure is broad and that any reused password is in attacker hands.`,
    });
  }
  if (passwords.length >= 2) {
    const sample = passwords.slice(0, 3).map((p) => `\`${p.value}\``).join(", ");
    notes.push({
      text: `Password reuse pattern detected (${sample}). Treat any account secured by this family as compromised.`,
    });
  }

  const FIN = /(robinhood|coinbase|gatehub|kraken|gemini|binance|paypal|venmo|cashapp|wise|fidelity|schwab|chase|wells.?fargo|amex|amextax)/i;
  const financial = artifacts.filter((a) => FIN.test(a.value) || FIN.test(String(a.metadata?.site ?? "")));
  if (financial.length >= 2) {
    notes.push({
      text: `Multiple financial accounts tied to the same identity — credential-stuffing risk against either is high. Owner should be assumed at material financial risk.`,
    });
  }

  const hasName = artifacts.some((a) => ["name", "person"].includes(a.kind.toLowerCase()));
  const hasPhone = artifacts.some((a) => a.kind.toLowerCase() === "phone");
  const hasDob = artifacts.some((a) => a.kind.toLowerCase() === "dob");
  if (hasName && hasPhone && hasDob) {
    notes.push({
      text: `Full PII triad (name + phone + DOB) is present. This enables SIM-swap, voice-phishing, and KBA bypass against banks and brokers.`,
    });
  }

  return notes;
}

function buildUnknowns(artifacts: Artifact[]): string[] {
  const out: string[] = [];
  const groups = new Set(artifacts.map((a) => groupForKind(a.kind)));
  if (!artifacts.some((a) => a.kind.toLowerCase() === "address")) {
    out.push("No street address, city confirmation, or postal code recovered.");
  }
  if (!groups.has("social")) {
    out.push("No social media handles confirmed on live platforms.");
  }
  if (!artifacts.some((a) => a.kind.toLowerCase() === "ip")) {
    out.push("No device fingerprint, IP, or stealer-log presence observed.");
  }
  const hashes = artifacts.filter((a) => a.kind.toLowerCase() === "hash");
  if (hashes.length) {
    out.push(`${hashes.length} password hash${hashes.length === 1 ? "" : "es"} recovered but uncracked — plaintext unknown.`);
  }
  const audit = buildToolAudit(artifacts);
  const gaps = inferToolGaps(audit);
  for (const g of gaps.slice(0, 2)) {
    out.push(`Coverage gap on ${g.kind}: ${g.suggested.slice(0, 3).map((t) => toolActionLabel(t)).join(", ")} not yet attempted.`);
  }
  return out;
}

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

function computeRisk(artifacts: Artifact[]): { level: RiskLevel; risks: string[] } {
  const risks: string[] = [];
  let score = 0;

  const breaches = artifacts.filter((a) => a.kind.toLowerCase() === "breach").length;
  const passwords = artifacts.filter((a) => a.kind.toLowerCase() === "password").length;
  const hasName = artifacts.some((a) => ["name", "person"].includes(a.kind.toLowerCase()));
  const hasPhone = artifacts.some((a) => a.kind.toLowerCase() === "phone");
  const hasDob = artifacts.some((a) => a.kind.toLowerCase() === "dob");
  const FIN = /(robinhood|coinbase|gatehub|kraken|gemini|binance|paypal|venmo|cashapp|fidelity|schwab|chase|wells.?fargo|amex)/i;
  const ADULT = /(meetmindful|passionsnetwork|adultfriendfinder|ashleymadison|onlyfans|fansly)/i;

  const financial = artifacts.filter((a) => FIN.test(a.value) || FIN.test(String(a.metadata?.site ?? ""))).length;
  const adult = artifacts.filter((a) => ADULT.test(a.value) || ADULT.test(String(a.metadata?.site ?? ""))).length;

  if (breaches >= 1) score += 1;
  if (breaches >= 3) score += 1;
  if (passwords >= 1) score += 1;
  if (hasName && hasPhone && hasDob) score += 2;
  if (financial >= 2) score += 2;
  if (adult >= 1) score += 1;

  if (financial >= 2) {
    risks.push("Multiple financial accounts tied to the same identity — credential-stuffing exposure is plausible.");
  }
  if (hasName && hasPhone && hasDob) {
    risks.push("Full PII triad (name + phone + DOB) enables SIM-swap, voice-phishing, and KBA bypass on banks and brokers.");
  }
  if (adult >= 1) {
    risks.push("Sensitive-platform registrations create sextortion / outing leverage if combined with name and phone.");
  }
  if (passwords >= 2) {
    risks.push("Password reuse pattern detected — low password hygiene increases account-takeover risk across services.");
  }
  if (breaches >= 3) {
    risks.push(`Subject appears in ${breaches} breach corpora — assume broad credential exposure.`);
  }

  const level: RiskLevel =
    score >= 6 ? "CRITICAL" : score >= 4 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW";
  return { level, risks };
}

const RISK_COLOR: Record<RiskLevel, string> = {
  LOW: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/60",
  MEDIUM: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/60",
  HIGH: "text-[hsl(var(--warning))] border-[hsl(var(--warning))]/70",
  CRITICAL: "text-destructive border-destructive/70",
};

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export function CaseReport({
  seedValue,
  seedType,
  artifacts,
  reviews,
}: {
  seedValue: string | null;
  seedType: string | null;
  artifacts: Artifact[];
  /** Analyst review verdicts by artifact id. Drives bucketing + adjusted confidence. */
  reviews?: ReviewMap;
}) {
  const identity = useMemo(() => buildIdentityRows(artifacts, reviews), [artifacts, reviews]);
  const registrations = useMemo(() => buildRegistrationRows(artifacts, reviews), [artifacts, reviews]);
  const hunterNotes = useMemo(() => buildHunterNotes(artifacts, seedValue), [artifacts, seedValue]);
  const unknowns = useMemo(() => buildUnknowns(artifacts), [artifacts]);
  const risk = useMemo(() => computeRisk(artifacts), [artifacts]);

  // Analyst review tally — surfaces the verdicts that previously never reached
  // the report at all (they only showed in the Evidence view).
  const reviewTally = useMemo(() => {
    let verified = 0, rejected = 0, needs = 0;
    for (const a of artifacts) {
      const r = reviewOf(reviews, a.id);
      if (r === "confirmed" || r === "key") verified++;
      else if (r === "dismissed" || r === "wrong") rejected++;
      else if (r === "recheck") needs++;
    }
    return { verified, rejected, needs, total: verified + rejected + needs };
  }, [artifacts, reviews]);

  // Evidence-strength buckets — analyst review verdicts override source status.
  const buckets = useMemo(() => {
    const g: Record<string, Artifact[]> = { confirmed: [], probable: [], lead: [], contradiction: [], excluded: [] };
    for (const a of artifacts) g[bucket(a, reviewOf(reviews, a.id))].push(a);
    return g;
  }, [artifacts, reviews]);

  const safetyFlags = useMemo(
    () => artifacts.filter((a) => {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      return m.possible_minor === true || m.auto_pivot_blocked === true || statusOf(a) === "manual_review_required";
    }),
    [artifacts],
  );

  const nextPivots = useMemo(() => {
    const pivots: string[] = [];
    for (const a of [...buckets.probable, ...buckets.lead].slice(0, 8)) {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      const step = (m.next_verification_step as string) || "";
      if (step) pivots.push(`${a.kind}:${a.value} → ${step}`);
    }
    return pivots.slice(0, 6);
  }, [buckets]);

  return (
    <article id="case-report-print-root" className="text-[12.5px] leading-relaxed text-foreground/95">
      {/* Header */}
      <header className="space-y-1.5 border-b border-border-subtle pb-3">
        <div className="text-eyebrow uppercase tracking-[0.2em] text-muted-foreground">
          Case file
        </div>
        <h2 className="text-lg font-display font-semibold break-all leading-snug">
          {seedValue ?? "—"}
        </h2>
        {/* One calm scope line. The bucket counts (confirmed/probable/leads)
            live in the Executive Summary prose below; artifact/tool totals are
            owned by the Evidence/Tools tab badges — not repeated here. */}
        <div className="font-mono text-data text-muted-foreground">
          {seedType ?? "unknown"} · {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"} analyzed
        </div>
        {reviewTally.total > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-eyebrow font-mono uppercase tracking-wider">
            <span className="text-muted-foreground/70">Analyst review</span>
            {reviewTally.verified > 0 && (
              <span className={cn("px-1.5 py-0.5 rounded border", REVIEW_CLASS.confirmed)}>{reviewTally.verified} verified</span>
            )}
            {reviewTally.rejected > 0 && (
              <span className={cn("px-1.5 py-0.5 rounded border", REVIEW_CLASS.wrong)}>{reviewTally.rejected} rejected</span>
            )}
            {reviewTally.needs > 0 && (
              <span className={cn("px-1.5 py-0.5 rounded border", REVIEW_CLASS.recheck)}>{reviewTally.needs} recheck</span>
            )}
          </div>
        )}
      </header>

      {/* 1. Executive summary */}
      <SectionHeader>Executive Summary</SectionHeader>
      <p className="text-foreground/90">
        Investigation of <span className="font-mono">{seedValue ?? "—"}</span> produced{" "}
        {buckets.confirmed.length} confirmed, {buckets.probable.length} probable, and{" "}
        {buckets.lead.length} unverified leads. {buckets.contradiction.length} contradictions
        were detected. Source-based confidence caps are applied conservatively — breach-only
        evidence cannot exceed 65 without independent corroboration.
      </p>

      {/* 2. Safety / legal flags */}
      {safetyFlags.length > 0 && (
        <>
          <SectionHeader tone="danger">Safety / Legal Flags</SectionHeader>
          <BucketTable rows={safetyFlags} empty="No safety flags." reviews={reviews} />
        </>
      )}

      {/* 3. Seed details */}
      <SectionHeader>Seed Details</SectionHeader>
      <div className="text-foreground/90 font-mono text-data">
        {seedType ?? "unknown"} · {seedValue ?? "—"}
      </div>

      {/* 4. Confirmed findings */}
      <SectionHeader>Confirmed Findings</SectionHeader>
      <BucketTable rows={buckets.confirmed} empty="No findings meet the confirmation threshold (official + independent corroboration)." reviews={reviews} />

      {/* 5. Probable findings */}
      <SectionHeader>Probable Findings</SectionHeader>
      <BucketTable rows={buckets.probable} empty="No probable findings." reviews={reviews} />

      {/* 6. Leads requiring verification */}
      <SectionHeader>Leads Requiring Verification</SectionHeader>
      <BucketTable rows={buckets.lead.slice(0, 40)} empty="No outstanding leads." reviews={reviews} />

      {/* 7. Excluded / collision clusters */}
      {buckets.excluded.length > 0 && (
        <>
          <SectionHeader>Excluded / Collision Clusters</SectionHeader>
          <BucketTable rows={buckets.excluded} empty="—" reviews={reviews} />
        </>
      )}

      {/* 9. Contradictions */}
      {buckets.contradiction.length > 0 && (
        <>
          <SectionHeader tone="danger">Contradictions &amp; Data Quality Problems</SectionHeader>
          <BucketTable rows={buckets.contradiction} empty="—" reviews={reviews} />
        </>
      )}

      {/* 14. Recommended next pivots */}
      {nextPivots.length > 0 && (
        <>
          <SectionHeader>Recommended Next Pivots</SectionHeader>
          <ul className="space-y-1.5 list-disc pl-5 text-foreground/90 font-mono text-data">
            {nextPivots.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </>
      )}

      {/* Identity */}
      {identity.length > 0 && (
        <>
          <SectionHeader>Identity</SectionHeader>
          <div className="rounded-md border border-border-subtle overflow-x-auto [scrollbar-width:thin]">
            <table className="w-full min-w-[420px] text-data">
              <thead>
                <tr className="bg-surface-2 text-eyebrow uppercase tracking-[0.15em] text-muted-foreground">
                  <th className="text-left font-normal px-3 py-2 w-[35%]">Field</th>
                  <th className="text-left font-normal px-3 py-2">Value</th>
                  <th className="text-left font-normal px-3 py-2 w-[110px]">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {identity.map((r, i) => (
                  <tr key={i} className="border-t border-border-subtle">
                    <td className="px-3 py-2 text-muted-foreground">{r.field}</td>
                    <td className="px-3 py-2 font-mono break-all">{r.value}</td>
                    <td className="px-3 py-2"><ConfPill label={r.label} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Hunter's notes (after identity, before registrations) */}
      {hunterNotes.slice(0, 2).map((n, i) => <HunterNote key={`hn-top-${i}`}>{n.text}</HunterNote>)}

      {/* Sensitive registrations */}
      {registrations.length > 0 && (
        <>
          <SectionHeader>Sensitive Registrations</SectionHeader>
          <div className="rounded-md border border-border-subtle overflow-x-auto [scrollbar-width:thin]">
            <table className="w-full min-w-[520px] text-data">
              <thead>
                <tr className="bg-surface-2 text-eyebrow uppercase tracking-[0.15em] text-muted-foreground">
                  <th className="text-left font-normal px-3 py-2 w-[30%]">Site</th>
                  <th className="text-left font-normal px-3 py-2">Account identifier</th>
                  <th className="text-left font-normal px-3 py-2 w-[120px]">Source</th>
                  <th className="text-left font-normal px-3 py-2 w-[110px]">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r, i) => (
                  <tr key={i} className="border-t border-border-subtle align-top">
                    <td className="px-3 py-2">{r.site}</td>
                    <td className="px-3 py-2 font-mono break-all">{r.identifier}</td>
                    <td className="px-3 py-2 text-muted-foreground text-data">{r.source}</td>
                    <td className="px-3 py-2"><ConfPill label={r.label} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Remaining hunter notes */}
      {hunterNotes.slice(2).map((n, i) => <HunterNote key={`hn-rest-${i}`}>{n.text}</HunterNote>)}

      {/* What we don't know */}
      {unknowns.length > 0 && (
        <>
          <SectionHeader>What We Don't Know</SectionHeader>
          <ul className="space-y-2 list-disc pl-5 text-foreground/90">
            {unknowns.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </>
      )}

      {/* Risk level */}
      <SectionHeader>Risk Level</SectionHeader>
      <div className={cn("rounded-md border-t-2 border border-border-subtle bg-surface-2 p-4", RISK_COLOR[risk.level])}>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-current" />
          <span className="px-2 py-0.5 rounded border border-current text-eyebrow font-mono uppercase tracking-[0.2em]">
            {risk.level}
          </span>
        </div>
        <div className="mt-3 text-eyebrow uppercase tracking-[0.2em] text-muted-foreground">
          Key risks
        </div>
        {risk.risks.length === 0 ? (
          <p className="mt-2 text-foreground/80">
            No elevated risk indicators detected from the current evidence.
          </p>
        ) : (
          <ul className="mt-2 space-y-2 list-disc pl-5 text-foreground/90">
            {risk.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </div>
    </article>
  );
}