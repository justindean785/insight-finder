import { useMemo, useState } from "react";
import { sanitizeChatText } from "@/lib/sanitize-agent-text";
import {
  Bar,
  BarChart,
  CartesianGrid,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import type { Artifact } from "@/hooks/useThreadArtifacts";
// One number, everywhere. See src/lib/display-confidence.ts.
import { effectiveConfidence } from "@/lib/display-confidence";
import { artifactsToSources, artifactsToClusterAudit, reportVerdict, type ReportVerdict } from "@/lib/audit/from-artifacts";
import { checkIndependence, computeEffectiveSourceCount } from "@/lib/audit/source-independence";
import { lintReport } from "@/lib/audit/confidence-linter";
import { SourceBadge } from "@/components/SourceBadge";
import { breachSeverity, isAiSummaryArtifact, isDobPlaceholder, qualConfidence } from "@/lib/report-badges";
import { EvidenceStatusBadge, StatusLegend } from "@/components/ui/workspace-primitives";
import { ConfidenceBar } from "@/components/ui/confidence";
import { evidenceStatus } from "@/lib/evidence-status";
// #499 — the engine's own adjudication, so the KPIs above cannot be read as one.
import { AUTHORITY_HEADING, authorityStatement, type AuthoritativeFindings } from "@/lib/authoritative-findings";
import { tierInfo } from "@/lib/confidence-tier";
import {
  labelForArtifact,
  buildIdentityClusters,
  buildToolAudit,
  inferToolGaps,
  groupForKind,
  GROUP_LABEL,
  displayKind,
  extractSourceInfo,
  isReputationArtifact,
  type ConfLabel,
  type ReviewAdjustment,
} from "@/lib/intel";
import { formatArtifactDisplayValue, buildIdentityRows, isClusterIneligible, isNullResultValue, isSubjectAuthorityEligible, pickSubjectName, type IdentityRow } from "@/lib/report-hygiene";
import { toolActionLabel } from "@/lib/tool-display";
import { tokenizeSourceChain } from "@/lib/report-source-labels";
import { cn } from "@/lib/utils";
import { isRejectedReview, type ReviewState } from "@/lib/review";
import { independentSourceClasses } from "@/lib/intel";
import { isAnalystConfirmed } from "@/lib/analyst-confirmed";
import { extractDisplaySeed } from "@/lib/seed";
import type { MessageSummary } from "@/hooks/useThreadMessages";
import { isBreachKind } from "@/lib/breach-kinds";
import { isRejectedArtifact as isRejectedArtifactRow, buildRejectedDerivationIds } from "@/lib/analyst-decisions";
import { normalizeTarget } from "@/lib/next-step-cards";

export type ReportType = "full" | "brief";

/* ------------------------------------------------------------------ */
/* Evidence-strength bucketing                                         */
/* ------------------------------------------------------------------ */

/**
 * #478 — analyst verdicts reach the report.
 *
 * `CaseReport` declared a `reviews` prop and never destructured it, so every
 * number and label below was computed from the raw artifact while
 * `ConfidenceRadar` — same tab, same object (`ReportTab.tsx:235` vs `:242`) —
 * honoured the verdict. These two accessors mirror `buildReportMarkdown`
 * (`intel.ts:1149-1150`) exactly, so the on-screen report and the markdown
 * export cannot drift: the label always goes through the review, and the number
 * is `displayConfidence(a).effective` — the same value every other surface
 * renders. (Until 2026-08-31 the number went through `adjustedConfidence` only
 * when a verdict existed, which made the report agree with the Evidence BOARD on
 * an unreviewed row and with the Evidence TABLE on a reviewed one.)
 *
 * No new policy is invented here. `labelForArtifact` and `evidenceStatus`
 * already take a review and already encode the semantics (dismissed/wrong =>
 * FAILED => rejected => excluded; confirmed/key => CONFIRMED, subject to the
 * possible-minor and quarantine floors). This is plumbing that was missing.
 */
type Reviews = Record<string, ReviewAdjustment> | undefined;
const revOf = (reviews: Reviews, a: Artifact): ReviewAdjustment => reviews?.[a.id];
/** May this row speak for the subject? See `isSubjectAuthorityEligible`. */
const forSubject = (reviews: Reviews, a: Artifact): boolean => isSubjectAuthorityEligible(a, revOf(reviews, a));
/** Rows DERIVED from an analyst-rejected selector. The markdown export's
 *  provenance rule (`buildReportMarkdown`): rejection follows provenance, so a
 *  breach pulled from a rejected email leaves the subject's sections with it. */
function rejectedDerivedIds(artifacts: Artifact[], reviews: Reviews): Set<string> {
  const rejectedIds = new Set(artifacts.filter((a) => isRejectedArtifactRow(a, revOf(reviews, a))).map((a) => a.id));
  return buildRejectedDerivationIds(artifacts, rejectedIds, normalizeTarget);
}
/** Breach rows that actually put the SUBJECT in a corpus: authority-eligible,
 *  not derived from a rejected selector, and not a "no breach hits" negative.
 *  Feeds counts that assert exposure, so they agree with the Breach Exposure
 *  table, which applies the same gates. */
const subjectBreaches = (artifacts: Artifact[], reviews: Reviews): Artifact[] => {
  const derived = rejectedDerivedIds(artifacts, reviews);
  return artifacts.filter((a) =>
    isBreachKind(a.kind) && forSubject(reviews, a) && !derived.has(a.id) && !isNullResultValue(a.value, a.source));
};
// THE report's number, and it is now the same number as every other surface's.
// This used to be `review ? adjustedConfidence(a, review) : a.confidence`, so the
// report agreed with the Evidence BOARD on an unreviewed row and with the
// Evidence TABLE on a reviewed one — a third pipeline that changed which of the
// other two it matched depending on whether an analyst had clicked Confirm.
// `reviews` is retained in the signature because callers pass it and because
// review state still drives bucketing and status elsewhere in this file; it just
// no longer moves the figure. See src/lib/display-confidence.ts.
const confOf = (_reviews: Reviews, a: Artifact): number | null => effectiveConfidence(a);

function statusOf(a: Artifact): string {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return String((m.status as string) ?? "new");
}
function bucket(a: Artifact, review?: ReviewAdjustment): "confirmed" | "probable" | "lead" | "contradiction" | "excluded" {
  const rawStatus = statusOf(a);
  const kind = a.kind.toLowerCase();
  if (kind === "contradiction" || rawStatus === "contradicted") return "contradiction";
  // THE ENGINE'S OWN PREDICATE, not a re-derivation of it — same reasoning as
  // `authorityFor` (src/lib/authority.ts). `evidenceStatus` below consults none
  // of the collision flags, so without this gate a `possible_collision` row
  // that also clears the corroboration bar reads "verified" and lands in this
  // report's CONFIRMED bucket — while the Evidence board (via `authorityFor`)
  // already demotes the identical row to quarantined. Same defect shape as
  // #448, one layer up, at a call site that fix never reached (measured on the
  // harness fixture: a possible_collision row with a caveat explaining it is a
  // different, unrelated person rendered in "Confirmed Findings"). `isClusterIneligible`
  // is a strict superset of the two ad hoc checks this replaced
  // (`excluded_collision` kind and `status: "excluded"` are both covered by
  // `isCollisionArtifact`), so this only WIDENS what gets excluded, never narrows it.
  if (isClusterIneligible(a)) return "excluded";
  const status = evidenceStatus(a, review).status;
  if (status === "contradicted") return "contradiction";
  if (status === "rejected") return "excluded";
  if (status === "verified") return "confirmed";
  if (status === "probable" || status === "verified_infrastructure") return "probable";
  return "lead";
}

function ArtifactRow({ a, review }: { a: Artifact; review?: ReviewAdjustment }) {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const status = evidenceStatus(a, review);
  // Excluded namesakes/collisions are not part of the subject's network — render
  // them de-emphasised (dimmed + struck value) so they never read as live leads.
  const isExcluded = bucket(a, review) === "excluded";
  // AI-asserted-but-unverified items (provenance guard) get the evidence-vs-
  // inference treatment: a faint amber wash + an "inferred" marker, so they look
  // distinct from a sourced observation.
  const isInferred = m.provenance_verified === false || m.provenance === "llm_asserted_unverified" || isAiSummaryArtifact(a);
  return (
    <tr
      className={cn(
        "border-t border-white/[0.06] align-top",
        isExcluded && "opacity-55",
      )}
      style={isInferred && !isExcluded ? { backgroundColor: "hsl(var(--conf-possible) / 0.05)" } : undefined}
    >
      <td className="px-3 py-2 text-muted-foreground text-eyebrow uppercase tracking-wider">{displayKind(a)}</td>
      <td className={cn("px-3 py-2 font-mono break-words [overflow-wrap:anywhere]", isExcluded && "line-through decoration-muted-foreground/50")}>
        {formatArtifactDisplayValue(a.value)}
        {isInferred && !isExcluded && (
          <span className="ml-2 align-middle rounded border border-conf-possible/40 bg-conf-possible/10 px-1 py-px text-micro font-mono uppercase tracking-wider text-conf-possible no-underline">
            inferred · unverified
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-data text-muted-foreground break-words [overflow-wrap:anywhere]" title={a.source ?? undefined}>
        <SourcePills artifact={a} />
      </td>
      <td className="px-3 py-2">
        <EvidenceStatusBadge status={status.status} label={status.label} tone={status.tone} hint={status.hint} />
        <div className="mt-1 text-eyebrow leading-snug text-muted-foreground">{status.basis}</div>
      </td>
      <td className="px-3 py-2 text-data">
        <ConfidenceBar score={effectiveConfidence(a)} showValue className="min-w-[5.5rem]" />
      </td>
      <td className="px-3 py-2 text-data text-muted-foreground whitespace-nowrap">
        {new Date(a.created_at).toLocaleDateString()}
      </td>
      <td className="px-3 py-2 text-data text-muted-foreground">
        {String((m.reason_for_confidence as string) ?? "")}
        {m.reason_not_confirmed ? <div className="text-destructive/80">{String(m.reason_not_confirmed)}</div> : null}
      </td>
    </tr>
  );
}

function SourcePills({ artifact }: { artifact: Artifact }) {
  return <SourceBadges sources={extractSourceInfo(artifact).all} />;
}

function SourceBadges({ sources }: { sources: string[] }) {
  if (!sources.length) return <>—</>;
  return (
    <span className="inline-flex max-w-full flex-wrap gap-1">
      {sources.map((source) => (
        <SourceBadge
          key={source}
          source={source}
          size="xs"
          className="max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-left !rounded-md"
        />
      ))}
    </span>
  );
}

function BucketTable({ rows, empty, reviews }: { rows: Artifact[]; empty: string; reviews?: Reviews }) {
  if (!rows.length) return <p className="text-muted-foreground italic text-data mt-2">{empty}</p>;
  return (
    <>
    <p className="no-print sm:hidden mt-2 -mb-1 text-eyebrow text-muted-foreground/70">Scroll horizontally to see all columns →</p>
    <div className="rounded-xl border border-white/[0.08] overflow-x-auto mt-2 bg-[hsl(var(--surface-1))/0.42] [scrollbar-width:thin]">
      <table className="report-evidence-table w-full min-w-[1024px] table-fixed [&_td]:align-top text-data">
        <thead>
          <tr className="bg-white/[0.035] text-micro font-medium tracking-normal text-muted-foreground">
            <th className="text-left font-normal px-3 py-2 w-[104px]">Kind</th>
            <th className="text-left font-normal px-3 py-2 w-[22%]">Value</th>
            <th className="text-left font-normal px-3 py-2 w-[168px]">Source</th>
            <th className="text-left font-normal px-3 py-2 w-[168px]">Status</th>
            <th className="text-left font-normal px-3 py-2 w-[96px]">Score</th>
            <th className="text-left font-normal px-3 py-2 w-[92px]">Captured</th>
            <th className="text-left font-normal px-3 py-2">Reasoning</th>
          </tr>
        </thead>
        <tbody>{rows.map((a) => <ArtifactRow key={a.id} a={a} review={revOf(reviews, a)} />)}</tbody>
      </table>
    </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Section header — red bar + ALL-CAPS spaced title, like the ref UI. */
/* ------------------------------------------------------------------ */
function SectionHeader({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="report-section-head flex items-center gap-2 mt-6 mb-3">
      <span className="w-[3px] h-4 bg-[hsl(var(--info))] rounded-sm" />
      <h3 className="text-title font-semibold tracking-normal text-[hsl(var(--info))]">
        {children}
      </h3>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

function HunterNote({ children }: { children: React.ReactNode }) {
  return (
    <aside className="my-3 rounded-md border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 text-foreground/90 leading-relaxed">
      <div className="text-micro font-semibold tracking-normal text-destructive mb-1">
        Hunter's Note
      </div>
      <div className="text-data">{children}</div>
    </aside>
  );
}

const CONF_PILL: Record<ConfLabel, string> = {
  CONFIRMED: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40",
  ATTESTED: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))] border-dashed",
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
  ATTESTED: "ANALYST-CONFIRMED",
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

type RegistrationRow = {
  site: string;
  identifier: string;
  source: string;
  label: ConfLabel;
};

/** The registration a row asserts (site + account identifier), or null when the row is not one. */
function registrationOf(a: Artifact): Pick<RegistrationRow, "site" | "identifier"> | null {
  const k = String(a.kind ?? "").toLowerCase();
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const site =
    (meta.site as string) ||
    (meta.platform as string) ||
    (meta.service as string) ||
    (meta.source_name as string) ||
    null;
  // #405 retired the bare "breach" kind in favour of breach_exposure; this
  // call site kept the literal, so the registrations table has been empty
  // for every investigation since. Same predicate as lines 340/405.
  if (isBreachKind(k) && !isReputationArtifact(a)) {
    return {
      site: site || String(a.value ?? "—"),
      identifier:
        (meta.identifier as string) ||
        (meta.email as string) ||
        (meta.username as string) ||
        (meta.account as string) ||
        "—",
    };
  }
  if ((k === "account" || k === "social" || k === "handle") && site) return { site, identifier: a.value };
  return null;
}

const registrationKey = (r: Pick<RegistrationRow, "site" | "identifier">): string =>
  `${String(r.site ?? "").toLowerCase()}|${String(r.identifier ?? "").toLowerCase()}`;

function buildRegistrationRows(artifacts: Artifact[], reviews?: Reviews): RegistrationRow[] {
  const derived = rejectedDerivedIds(artifacts, reviews);
  // A rejection is a verdict on the REGISTRATION, not on one row's id: a re-run
  // records the same site|identifier under a new id, and filtering by id with the
  // dedupe running afterwards would let that unreviewed twin render as a clean
  // row. Same rule as analyst-decisions.ts ("a re-record under a new id cannot
  // revive it"), keyed on this table's own identity.
  const rejectedKeys = new Set<string>();
  for (const a of artifacts) {
    if (!isRejectedArtifactRow(a, revOf(reviews, a)) && !derived.has(a.id)) continue;
    const reg = registrationOf(a);
    if (reg) rejectedKeys.add(registrationKey(reg));
  }
  const rows: RegistrationRow[] = [];
  for (const a of artifacts) {
    // Registrations assert subject membership, just like Breach Exposure.
    // Keep excluded rows in the evidence/review sections, not this table.
    if (!forSubject(reviews, a) || derived.has(a.id) || isNullResultValue(a.value, a.source)) continue;
    const reg = registrationOf(a);
    if (!reg || rejectedKeys.has(registrationKey(reg))) continue;
    rows.push({ ...reg, source: a.source ?? "—", label: labelForArtifact(a, revOf(reviews, a)) });
  }
  // Dedupe by site|identifier
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = registrationKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type HunterNoteItem = { text: string };

function buildHunterNotes(artifacts: Artifact[], seedValue: string | null, reviews?: Reviews): HunterNoteItem[] {
  const notes: HunterNoteItem[] = [];
  // Cluster WITH the analyst's verdicts: these warnings are shown as analyst
  // guidance, so deriving them from rows the analyst has dismissed tells them to
  // chase a lead they already closed.
  const cluster = buildIdentityClusters(artifacts, seedValue, reviews);
  for (const w of cluster.warnings.slice(0, 3)) notes.push({ text: w });

  const breaches = subjectBreaches(artifacts, reviews);
  // Every input below asserts something ABOUT THE SUBJECT, so a rejected or
  // quarantined namesake row must not feed any of them.
  const subject = artifacts.filter((a) => forSubject(reviews, a));
  const passwords = subject.filter((a) => a.kind.toLowerCase() === "password");
  if (breaches.length >= 3) {
    notes.push({
      text: `Subject appears in ${breaches.length} distinct breach corpora. Assume credential exposure is broad and that any reused password is in attacker hands.`,
    });
  }
  if (passwords.length >= 2) {
    // Credential-masking policy: indicate presence/count, NEVER the plaintext
    // values (the report elsewhere states creds are masked — keep that promise).
    notes.push({
      text: `Password reuse pattern detected across ${passwords.length} exposed credentials (values masked by policy). Treat any account secured by this family as compromised.`,
    });
  }

  const FIN = /(robinhood|coinbase|gatehub|kraken|gemini|binance|paypal|venmo|cashapp|wise|fidelity|schwab|chase|wells.?fargo|amex|amextax)/i;
  const financial = subject.filter((a) => FIN.test(a.value) || FIN.test(String(a.metadata?.site ?? "")));
  if (financial.length >= 2) {
    notes.push({
      text: `Multiple financial accounts tied to the same identity — credential-stuffing risk against either is high. Owner should be assumed at material financial risk.`,
    });
  }

  const hasName = subject.some((a) => ["name", "person"].includes(a.kind.toLowerCase()));
  const hasPhone = subject.some((a) => a.kind.toLowerCase() === "phone");
  const hasDob = subject.some((a) => a.kind.toLowerCase() === "dob");
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

function computeRisk(artifacts: Artifact[], reviews?: Reviews): { level: RiskLevel; risks: string[] } {
  const risks: string[] = [];
  let score = 0;

  const breaches = subjectBreaches(artifacts, reviews).length;
  // Same gate as the Hunter's Note: a namesake must not raise the SUBJECT's risk.
  const subject = artifacts.filter((a) => forSubject(reviews, a));
  const passwords = subject.filter((a) => a.kind.toLowerCase() === "password").length;
  const hasName = subject.some((a) => ["name", "person"].includes(a.kind.toLowerCase()));
  const hasPhone = subject.some((a) => a.kind.toLowerCase() === "phone");
  const hasDob = subject.some((a) => a.kind.toLowerCase() === "dob");
  const FIN = /(robinhood|coinbase|gatehub|kraken|gemini|binance|paypal|venmo|cashapp|fidelity|schwab|chase|wells.?fargo|amex)/i;
  const ADULT = /(meetmindful|passionsnetwork|adultfriendfinder|ashleymadison|onlyfans|fansly)/i;

  const financial = subject.filter((a) => FIN.test(a.value) || FIN.test(String(a.metadata?.site ?? ""))).length;
  const adult = subject.filter((a) => ADULT.test(a.value) || ADULT.test(String(a.metadata?.site ?? ""))).length;

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

type ReportMetric = {
  label: string;
  value: number;
  detail: string;
};

type ChartDatum = {
  name: string;
  value: number;
};

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function averageConfidence(artifacts: Artifact[], reviews?: Reviews): number {
  // A rejected row may not strengthen a positive aggregate, so it is EXCLUDED
  // rather than clamped — which also matches buildIdentityClusters.
  //
  // The original reason for excluding was arithmetic: `confOf` used to route a
  // reviewed row through `adjustedConfidence`, and since `REVIEW_DELTA` has no
  // `dismissed` entry, dismissing a row swapped in a corroboration bonus the
  // unreviewed branch never applied and could RAISE the average by up to +15.
  // That mechanism is gone — `confOf` is now `min(stored, cap)` for every row,
  // reviewed or not. The exclusion stays because the POLICY was always right on
  // its own terms: a row the analyst rejected should not lift the case average.
  const vals = artifacts
    .filter((a) => !isRejectedReview(revOf(reviews, a)))
    .map((a) => confOf(reviews, a))
    .filter((n): n is number => typeof n === "number");
  if (!vals.length) return 0;
  return Math.round(vals.reduce((sum, n) => sum + n, 0) / vals.length);
}

function uniqueSources(artifacts: Artifact[]): string[] {
  const sources = new Set<string>();
  for (const a of artifacts) {
    for (const source of extractSourceInfo(a).all) sources.add(source);
  }
  return Array.from(sources).sort((a, b) => a.localeCompare(b));
}

// Expected independent source categories used by the classifier — Coverage and
// Corroboration measure against these, NOT raw tool/source-label counts.
const EXPECTED_SOURCE_CATEGORIES = [
  "breach", "public_record", "social_profile_passive", "news",
  "court_record", "infra", "username_sweep", "threat_intel",
];

/** Distinct independent source CLASSES for one artifact (metadata.source_category). */
function artifactSourceClasses(a: Artifact): Set<string> {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const cats = m.source_category;
  const set = new Set<string>();
  if (Array.isArray(cats)) {
    for (const c of cats) if (typeof c === "string" && c.trim()) set.add(c.trim().toLowerCase());
  } else if (typeof cats === "string" && cats.trim()) {
    set.add(cats.trim().toLowerCase());
  }
  return set;
}

/**
 * Findings backed by >=2 INDEPENDENT source classes, among rows bucket() would
 * not exclude. The ONE definition of "corroborated": the Cross-source radar axis
 * and the Independently-corroborated panel
 * both call it, so they can never disagree. Analyst review is deliberately not an
 * input - a human vouching for a single-source row does not make it corroborated.
 */
export function countIndependentlyCorroborated(artifacts: Artifact[], reviews?: Reviews): number {
  // Eligibility is bucket()'s own: quarantined, collision, contradicted and
  // rejected rows land in "excluded"/"contradiction" and are never corroboration.
  return artifacts.filter((a) => {
    const b = bucket(a, revOf(reviews, a));
    return b !== "excluded" && b !== "contradiction" && independentSourceClasses(a).length >= 2;
  }).length;
}

/** Rows an analyst has confirmed/keyed (or that carry metadata.reviewed). A separate axis from corroboration. */
export function countAnalystConfirmed(artifacts: Artifact[], reviews?: Reviews): number {
  // Canonical predicate (labelForArtifact === "ATTESTED"): it already refuses
  // possible_minor, quarantined, conflict and false-positive rows.
  return artifacts.filter((a) => !isClusterIneligible(a) && isAnalystConfirmed(a, revOf(reviews, a))).length;
}

// DISPLAY-METRIC ONLY: these functions change what the radar axes COUNT. They do
// NOT touch confidence caps, source classification, or status derivation — Signal
// reuses the same bucket() the Confirmed/Probable counters use.
export function buildAnalyticRadar(artifacts: Artifact[], riskLevel: RiskLevel, reviews?: Reviews): ReportMetric[] {
  // ONE eligible-positive population for every axis that measures STRENGTH.
  // An analyst-rejected row may not seed or strengthen a positive metric — the
  // authority `buildIdentityClusters` already established (intel.ts:1865) and
  // that the pickers and averageConfidence now follow. Four separate rejection
  // checks would be four things to keep in step; this is one.
  //
  // Exposure is the reason this cannot be left to `confOf`: when
  // `metadata.severity` is numeric the strength sum never consults a confidence
  // at all, so rejection had ZERO effect on that axis.
  //
  // DENOMINATORS ARE DELIBERATELY NOT FILTERED. `total` stays `artifacts.length`
  // so rejecting a row can only lower or hold an axis, never raise one, and the
  // row still counts as a finding that exists. Signal is untouched — it already
  // excludes rejected rows through bucket(), which is the counters' own path.
  const positive = artifacts.filter((a) => !isRejectedReview(revOf(reviews, a)));
  const kinds = new Set(positive.map((a) => String(a.kind ?? "").toLowerCase()));
  const avg = averageConfidence(positive, reviews);
  const total = Math.max(artifacts.length, 1);

  const identityHits = ["name", "person", "phone", "email", "address", "dob", "age", "location"]
    .filter((kind) => kinds.has(kind)).length;

  // Exposure (BUG-1): the kind is `breach_exposure`; the old kind-category check
  // missed it and read 0 despite many breaches. Count exposure ARTIFACTS,
  // weighted by metadata.severity when present, else confidence.
  const exposureArts = positive.filter((a) =>
    ["breach_exposure", "credential_exposure", "leak_paste"].includes(String(a.kind ?? "")));
  const exposureStrength = exposureArts.reduce((s, a) => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const sev = typeof m.severity === "number" ? m.severity : null;
    return s + (sev != null ? sev / 100 : (confOf(reviews, a) ?? 50) / 100);
  }, 0);
  const exposureValue = exposureArts.length === 0 ? 0 : clampScore(Math.min(100, exposureStrength * 18));

  // Corroboration (BUG-3): findings backed by >=2 INDEPENDENT source classes,
  // NOT distinct source-label count (52 labels incl. 4x minimax != corroboration).
  const corroborated = countIndependentlyCorroborated(artifacts, reviews);
  const corroborationValue = clampScore((corroborated / total) * 100);

  // Coverage (BUG-4): observed source CATEGORIES vs the expected set, not tool count.
  const observedCats = new Set<string>();
  for (const a of positive) for (const c of artifactSourceClasses(a)) observedCats.add(c);
  const coveredExpected = EXPECTED_SOURCE_CATEGORIES.filter((c) => observedCats.has(c)).length;
  const coverageValue = clampScore((coveredExpected / EXPECTED_SOURCE_CATEGORIES.length) * 100);

  // Signal (BUG-2): reuse the SAME bucket() the Confirmed/Probable counters use,
  // so the axis can never contradict the counters.
  const sigConfirmed = artifacts.filter((a) => bucket(a, revOf(reviews, a)) === "confirmed").length;
  const sigProbable = artifacts.filter((a) => bucket(a, revOf(reviews, a)) === "probable").length;
  const signalValue = clampScore(((sigConfirmed + sigProbable) / total) * 100);

  const riskScore: Record<RiskLevel, number> = { LOW: 22, MEDIUM: 48, HIGH: 74, CRITICAL: 94 };

  return [
    { label: "Identity coverage", value: clampScore((identityHits / 8) * 100), detail: `${identityHits}/8 identity categories observed` },
    { label: "Cross-source", value: corroborationValue, detail: `${corroborated}/${artifacts.length} finding${artifacts.length === 1 ? "" : "s"} across ≥2 independent source classes` },
    { label: "Confidence", value: clampScore(avg), detail: `${avg}% average artifact confidence` },
    { label: "Exposure", value: exposureValue, detail: `${exposureArts.length} breach / credential-exposure finding${exposureArts.length === 1 ? "" : "s"}` },
    { label: "Coverage", value: coverageValue, detail: `${coveredExpected}/${EXPECTED_SOURCE_CATEGORIES.length} source categories represented` },
    { label: "Risk", value: riskScore[riskLevel], detail: `${riskLevel.toLowerCase()} current risk classification` },
    { label: "Signal", value: signalValue, detail: `${sigConfirmed + sigProbable}/${artifacts.length} findings confirmed or probable` },
  ];
}

function buildGroupDistribution(artifacts: Artifact[]): ChartDatum[] {
  const counts = new Map<string, number>();
  for (const a of artifacts) {
    const group = GROUP_LABEL[groupForKind(a.kind)] ?? "Other";
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

function buildSourceDistribution(artifacts: Artifact[]): ChartDatum[] {
  const counts = new Map<string, number>();
  for (const a of artifacts) {
    const sources = extractSourceInfo(a).all;
    for (const source of sources.length ? sources : ["unknown"]) {
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([name, value]) => ({ name: name.length > 18 ? `${name.slice(0, 17)}...` : name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

function buildConfidenceDistribution(artifacts: Artifact[], reviews?: Reviews): ChartDatum[] {
  const bands = [
    { name: "90-100", min: 90, max: 101 },
    { name: "75-89", min: 75, max: 90 },
    { name: "50-74", min: 50, max: 75 },
    { name: "0-49", min: 0, max: 50 },
    { name: "Unknown", min: -1, max: -1 },
  ];
  return bands.map((band) => ({
    name: band.name,
    value: artifacts.filter((a) => {
      if (band.name === "Unknown") return confOf(reviews, a) == null;
      const c = confOf(reviews, a) ?? -1;
      return c >= band.min && c < band.max;
    }).length,
  }));
}

function ReportChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="report-chart-card rounded-xl border border-white/[0.08] bg-[hsl(var(--surface-1))/0.72] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-meta font-mono font-semibold tracking-normal text-muted-foreground">{title}</div>
          <div className="mt-1 text-data text-muted-foreground">{subtitle}</div>
        </div>
      </div>
      <div className="mt-3 h-[230px] min-w-0">{children}</div>
    </div>
  );
}

function AnalyticRadar({ data }: { data: ReportMetric[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RadarChart data={data} outerRadius="74%">
        <PolarGrid stroke="hsl(var(--foreground) / 0.13)" radialLines />
        <PolarAngleAxis dataKey="label" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
        <Radar
          name="Score"
          dataKey="value"
          stroke="hsl(var(--info))"
          fill="hsl(var(--info))"
          fillOpacity={0.28}
          strokeWidth={2}
          dot={{ r: 2.5, fill: "hsl(var(--info))" }}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}

function CompactBarChart({ data, color = "hsl(var(--info))" }: { data: ChartDatum[]; color?: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="hsl(var(--foreground) / 0.06)" />
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={82}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
        />
        <Bar dataKey="value" radius={[0, 6, 6, 0]} fill={color} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

/* ---------- narrative / dossier helpers ---------- */

function topByConfidence(artifacts: Artifact[], kinds: string[], reviews?: Reviews): Artifact | null {
  // Case-insensitive kind match + null-safe read. `pickBest` already lowercases;
  // this keeps the narrative builders consistent so a capitalized/undefined
  // `kind` never silently drops a row (or throws into the ErrorBoundary).
  const set = new Set(kinds.map((k) => k.toLowerCase()));
  // Same rule as the identity pickers (`pickBestIdentity`): neither a rejected
  // row nor a quarantined/collision row may become the subject's headline
  // Name/Email/Phone/Address. Rejection alone let a quarantined name-only
  // breach echo headline the Subject Profile while the gated Identity panel on
  // the same page named a different person.
  const pool = artifacts.filter(
    (a) => set.has(String(a.kind ?? "").toLowerCase()) && forSubject(reviews, a),
  );
  if (!pool.length) return null;
  return pool.slice().sort((a, b) => (confOf(reviews, b) ?? 0) - (confOf(reviews, a) ?? 0))[0];
}

type ProfileField = { label: string; value: string; note?: string };
function buildSubjectProfile(artifacts: Artifact[], reviews?: Reviews): ProfileField[] {
  const out: ProfileField[] = [];
  const name = topByConfidence(artifacts, ["name", "person"], reviews);
  if (name) {
    // A single-source name is a candidate, not a finding: say so beside the value
    // instead of rendering it as a plain fact.
    const nameClasses = independentSourceClasses(name).length;
    const nameAttested = isAnalystConfirmed(name, revOf(reviews, name));
    const nameNote = nameClasses >= 2
      ? undefined
      : nameAttested
        ? "Analyst-confirmed · single-source"
        : nameClasses === 0
          ? "Candidate — needs review · no source class recorded"
          : `Candidate — needs review · ${nameClasses} source class${nameClasses === 1 ? "" : "es"}`;
    out.push({ label: "Name", value: name.value, note: nameNote });
    const m = (name.metadata ?? {}) as Record<string, unknown>;
    const dob = m.dob ? String(m.dob) : "";
    const age = m.age != null ? String(m.age) : "";
    if (dob || age) out.push({ label: "DOB / Age", value: [dob, age && `age ${age}`].filter(Boolean).join(" · ") });
  }
  const email = topByConfidence(artifacts, ["email"], reviews);
  if (email) out.push({ label: "Email", value: email.value });
  const phone = topByConfidence(artifacts, ["phone"], reviews);
  if (phone) out.push({ label: "Phone", value: phone.value });
  const addr = topByConfidence(artifacts, ["address"], reviews);
  if (addr) out.push({ label: "Address", value: addr.value });
  return out;
}

// Digital footprint — the "feels complete" prose block the reference dossier
// leads with. Presentation only: it surfaces already-classified handle/account/
// URL artifacts as clickable links grouped by platform; it does NOT re-rank,
// re-classify, or change any confidence/status.
type FootprintLink = { platform: string; value: string; href: string | null; inferred: boolean };
const FOOTPRINT_KINDS = new Set(["username", "handle", "account", "account_id", "social", "url", "domain", "website", "profile"]);
// Last-label values that look like a TLD but aren't — keeps file names / version
// strings from being turned into fake `https://` links.
const FOOTPRINT_NON_TLD = new Set([
  "pdf", "doc", "docx", "png", "jpg", "jpeg", "gif", "webp", "svg", "js", "ts",
  "tsx", "jsx", "json", "txt", "csv", "xml", "html", "htm", "zip", "md", "mp4",
  "mp3", "exe", "dll", "py", "rb", "go",
]);
// Exported for unit testing (pure presentation helper — no component state).
// eslint-disable-next-line react-refresh/only-export-components
export function buildProfileLinks(artifacts: Artifact[], reviews?: Reviews): FootprintLink[] {
  const out: FootprintLink[] = [];
  const seen = new Set<string>();
  for (const a of artifacts) {
    const kind = String(a.kind ?? "").toLowerCase();
    if (!FOOTPRINT_KINDS.has(kind)) continue;
    // "Digital Footprint" sits under the Subject Profile and reads as the
    // subject's; a rejected or quarantined handle is not.
    if (!forSubject(reviews, a)) continue;
    const value = String(a.value ?? "").trim();
    if (!value) continue;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const platform = String(m.platform ?? m.site ?? m.service ?? m.source_name ?? "").trim() || displayKind(a);
    const urlCand = [value, m.url, m.profile_url, m.source_url, m.link].find(
      (u) => typeof u === "string" && /^https?:\/\//i.test(u),
    ) as string | undefined;
    let href: string | null = urlCand ?? null;
    // Bare domain/handle-as-URL (e.g. "craftin247.bandcamp.com") → linkable, but
    // only when the host's last label looks like a real TLD (alpha, not a file
    // extension) so "resume.pdf", "v1.2.3", "Node.js", "2024.01.15" don't become
    // fake external links.
    if (!href) {
      const host = value.split("/")[0];
      const lastLabel = (host.split(".").pop() ?? "").toLowerCase();
      const looksLikeHost = /^[\w-]+(\.[\w-]+)+$/.test(host) && /^[a-z]{2,24}$/.test(lastLabel);
      if (looksLikeHost && !FOOTPRINT_NON_TLD.has(lastLabel)) href = `https://${value}`;
    }
    const key = `${platform.toLowerCase()}|${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const inferred = m.provenance_verified === false || m.provenance === "llm_asserted_unverified" || isAiSummaryArtifact(a);
    out.push({ platform, value, href, inferred });
  }
  return out;
}

// eslint-disable-next-line react-refresh/only-export-components
export function buildAliases(artifacts: Artifact[], reviews?: Reviews): string[] {
  const set = new Set<string>();
  for (const a of artifacts) {
    const kind = String(a.kind ?? "").toLowerCase();
    if ((kind === "username" || kind === "handle") && forSubject(reviews, a)) {
      const v = String(a.value ?? "").trim();
      if (v) set.add(v);
    }
  }
  return Array.from(set).slice(0, 12);
}

// A concrete, sensitive breach value the operator can unmask on click.
type RevealField = { label: string; value: string };
type BreachRow = {
  site: string;
  date: string;
  exposedFields: string[];   // field CLASSES exposed (e.g. "Password", "DOB") — safe to name
  reveal: RevealField[];     // concrete VALUES captured in the record — masked until clicked
  severity: "CRITICAL" | "HIGH" | null;
  minorRedacted: boolean;    // minor-safety hard stop: never revealable
};

const metaStr = (m: Record<string, unknown>, k: string): string =>
  typeof m[k] === "string" ? (m[k] as string).trim() : "";

/**
 * Breach-value display policy.
 *
 * OFF (current, and the default) — every captured breach value renders in the
 * clear. This is the platform owner's explicit, repeatedly-stated instruction:
 * while the app is being built, on the owner's own account, nothing about their
 * own authorized investigations is hidden from them. Masking the output makes
 * the product impossible to develop against, which is the whole reason it is off.
 *
 * ON (set `VITE_MASK_BREACH_VALUES=true` at release) — restores click-to-reveal,
 * the posture intended for public users.
 *
 * The minor-safety hard stop is NOT governed by this switch. A record flagged
 * minor-related stays redacted in BOTH modes and is never revealable; that is a
 * different protection with a different purpose and it is deliberately absolute.
 */
const MASK_BREACH_VALUES =
  String(import.meta.env.VITE_MASK_BREACH_VALUES ?? "").trim().toLowerCase() === "true";

/**
 * Every metadata key that can carry a CONCRETE captured value.
 *
 * This list is the contract half of `system-prompt.ts`, which instructs the model:
 * "you MUST record every concrete value returned (e.g. `concrete_values`,
 * `exposed_values`, `concrete_hits`, raw stealer credentials) into that finding's
 * artifact metadata."
 *
 * The report previously read ONLY `password_hash` plus the location quartet, so
 * every one of the keys the prompt actually names was dropped on the floor —
 * the model could do exactly as instructed and the analyst would still see "—".
 * Verified against a live 56-artifact case: zero rows carried `password_hash`,
 * so the reveal column was empty for the entire report.
 */
const CONCRETE_VALUE_KEYS: Array<[key: string, label: string]> = [
  ["password", "Password"],
  ["plaintext", "Password"],
  ["password_hash", "Password hash"],
  ["hash", "Hash"],
  ["salt", "Salt"],
  ["dob", "DOB"],
  ["raw_dob", "DOB"],
  ["phone", "Phone"],
  ["ip", "IP"],
  ["username", "Username"],
];

/** Keys whose value is a LIST of concrete values (arrays of strings/objects). */
const CONCRETE_LIST_KEYS = [
  "concrete_values", "exposed_values", "concrete_hits", "passwords", "credentials",
] as const;

/** Flatten one list-shaped metadata key into label/value pairs. */
function concreteListFields(m: Record<string, unknown>, key: string): RevealField[] {
  const raw = m[key];
  if (!Array.isArray(raw)) return [];
  const out: RevealField[] = [];
  for (const item of raw.slice(0, 25)) {
    if (typeof item === "string" && item.trim()) {
      out.push({ label: key.replace(/_/g, " "), value: item.trim() });
      continue;
    }
    if (item && typeof item === "object") {
      // {field, value} / {label, value} / {type, value} shapes all appear upstream.
      const o = item as Record<string, unknown>;
      const v = typeof o.value === "string" ? o.value.trim() : "";
      if (!v) continue;
      const lbl = [o.field, o.label, o.type, o.name].find((x) => typeof x === "string" && x);
      out.push({ label: String(lbl ?? key.replace(/_/g, " ")), value: v });
    }
  }
  return out;
}

/**
 * Build the breach-exposure rows from the REAL artifact metadata shape
 * (`exposed_fields`, `password_hash`, `zip`/`city`/…). Records for the SAME
 * breach are reported by several tools, so merge by breach name+date rather than
 * emitting duplicate rows — the merged row carries the union of exposed field
 * classes and any concrete value (e.g. the one tool that returned the hash).
 * Concrete values are collected for masked, click-to-reveal display; anything
 * flagged minor-related is marked non-revealable (minor-safety hard stop).
 *
 * Every row here is presented as a breach the SUBJECT appears in, so it takes the
 * same gate as the sibling subject surfaces (`forSubject`: not quarantined, not
 * rejected) plus the markdown export's provenance rule (`buildReportMarkdown`):
 * a row DERIVED from an analyst-rejected selector leaves with it. The rows are
 * not deleted — they stay in the Evidence tab; they just stop speaking for the
 * subject here. Masking and reveal are untouched.
 */
function buildBreachExposure(artifacts: Artifact[], reviews: Reviews): BreachRow[] {
  const derived = rejectedDerivedIds(artifacts, reviews);
  const byKey = new Map<string, BreachRow>();
  for (const a of artifacts) {
    if (String(a.kind ?? "").toLowerCase() !== "breach_exposure") continue;
    // Same three gates as `subjectBreaches`, whose count sits beside this table.
    if (!forSubject(reviews, a) || derived.has(a.id) || isNullResultValue(a.value, a.source)) continue;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    // Prefer the explicit breach name; else strip the "<selector> - " prefix off value.
    const site = (metaStr(m, "breach_name") || String(a.value ?? "").replace(/^.*?\s-\s/, "")).trim()
      || String(a.value ?? "");
    const date = metaStr(m, "breach_date");
    const exposedFields = Array.isArray(m.exposed_fields) ? m.exposed_fields.map(String) : [];
    // Concrete values actually present in the record → revealable.
    const reveal: RevealField[] = [];
    for (const [key, label] of CONCRETE_VALUE_KEYS) {
      const v = metaStr(m, key);
      if (v) reveal.push({ label, value: v });
    }
    for (const key of CONCRETE_LIST_KEYS) reveal.push(...concreteListFields(m, key));
    const loc = [metaStr(m, "city"), metaStr(m, "state"), metaStr(m, "zip"), metaStr(m, "country")]
      .filter(Boolean).join(" ");
    if (loc) reveal.push({ label: "Location", value: loc });
    // Same label+value from two tools is one fact, not two.
    const seenReveal = new Set<string>();
    const dedupedReveal = reveal.filter((r) => {
      const k = `${r.label}\u0000${r.value}`;
      if (seenReveal.has(k)) return false;
      seenReveal.add(k);
      return true;
    });
    reveal.length = 0;
    reveal.push(...dedupedReveal);
    // Minor-safety hard stop: a record flagged minor-related is never unmasked.
    const minorRedacted = m.possible_minor === true || m.minor_warning === true
      || String(m.flag ?? "").toUpperCase() === "MINOR_SAFETY_FLAG";
    const sev = breachSeverity(a);

    const key = `${site.toLowerCase()}|${date}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.exposedFields = Array.from(new Set([...existing.exposedFields, ...exposedFields]));
      for (const r of reveal) if (!existing.reveal.some((x) => x.label === r.label)) existing.reveal.push(r);
      if (!existing.severity && sev) existing.severity = sev;
      existing.minorRedacted = existing.minorRedacted || minorRedacted;
    } else {
      byKey.set(key, { site, date, exposedFields, reveal, severity: sev, minorRedacted });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** A single captured breach value. Shown in the clear unless MASK_BREACH_VALUES
 *  is on, in which case it is masked until the operator clicks Reveal. */
function MaskedValue({ label, value }: RevealField) {
  const [shown, setShown] = useState(!MASK_BREACH_VALUES);
  if (!MASK_BREACH_VALUES) {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-px font-mono text-eyebrow text-destructive">
        <span className="text-micro uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="break-all [overflow-wrap:anywhere]">{value}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setShown((s) => !s)}
      title={shown ? "Click to hide" : "Click to reveal this breach value"}
      className="group inline-flex max-w-full items-center gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-px font-mono text-eyebrow text-destructive transition-colors hover:bg-destructive/20"
    >
      <span className="text-micro uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="break-all [overflow-wrap:anywhere]">
        {shown ? value : "•".repeat(Math.min(12, Math.max(6, value.length)))}
      </span>
      <span className="shrink-0 text-micro opacity-70">{shown ? "Hide" : "Reveal"}</span>
    </button>
  );
}

/** Strongest identity-bearing artifact confidence — the reasoned read, distinct
 *  from the strict ≥2-independent-class auto-corroboration count. */
function analystConfidence(artifacts: Artifact[], reviews?: Reviews): number {
  // Identity-bearing FOR THE SUBJECT: an analyst-rejected namesake at 85 was
  // headlining "Analyst confidence 85% · HIGH" on a case whose only names were
  // rejected or quarantined.
  const pool = artifacts.filter((a) => ["name", "email", "phone", "address"].includes(a.kind) && forSubject(reviews, a));
  return pool.reduce((mx, a) => Math.max(mx, confOf(reviews, a) ?? 0), 0);
}

export function CaseReport({
  seedValue,
  seedType,
  artifacts,
  reviews,
  messages,
  reportType = "full",
  authority,
  draftMark = null,
  toolCallTotal,
}: {
  seedValue: string | null;
  seedType: string | null;
  artifacts: Artifact[];
  reviews?: Record<string, ReviewState>;
  messages?: MessageSummary[];
  reportType?: ReportType;
  /** #499 — from `selectAuthoritativeFindings`. Optional so existing callers and
   *  the dev harness keep working; when absent the panel is omitted rather than
   *  guessed at. */
  authority?: AuthoritativeFindings;
  /** Set when the report is NOT report-safe. Marks the document top and bottom,
   *  inside the print root, so every printed copy carries it. */
  draftMark?: { readinessPct: number; reasons: string[] } | null;
  /** Every recorded tool call for the case (the case bar's figure). Omitted, the
   *  chip is left out rather than printed as 0. */
  toolCallTotal?: number;
}) {
  const display = useMemo(() => extractDisplaySeed(seedValue, seedType), [seedValue, seedType]);
  const subjectProfile = useMemo(() => buildSubjectProfile(artifacts, reviews), [artifacts, reviews]);
  const corroboratedCount = useMemo(() => countIndependentlyCorroborated(artifacts, reviews), [artifacts, reviews]);
  const analystConfirmedCount = useMemo(() => countAnalystConfirmed(artifacts, reviews), [artifacts, reviews]);
  const profileLinks = useMemo(() => buildProfileLinks(artifacts, reviews), [artifacts, reviews]);
  const aliases = useMemo(() => buildAliases(artifacts, reviews), [artifacts, reviews]);
  const breachRows = useMemo(() => buildBreachExposure(artifacts, reviews), [artifacts, reviews]);
  const analystConf = useMemo(() => analystConfidence(artifacts, reviews), [artifacts, reviews]);
  const narrative = useMemo(() => {
    const last = (messages ?? []).filter((m) => m.role === "assistant" && m.summary?.trim()).slice(-1)[0];
    // Same display sanitizer as the chat timeline: echoed system markers and
    // leaked reasoning/tool-call markup are never report text.
    return sanitizeChatText(last?.summary?.trim() ?? "");
  }, [messages]);
  const isBrief = reportType === "brief";
  const identity = useMemo(() => buildIdentityRows(artifacts, reviews), [artifacts, reviews]);
  const registrations = useMemo(() => buildRegistrationRows(artifacts, reviews), [artifacts, reviews]);
  const hunterNotes = useMemo(() => buildHunterNotes(artifacts, seedValue, reviews), [artifacts, seedValue, reviews]);
  const unknowns = useMemo(() => buildUnknowns(artifacts), [artifacts]);
  const risk = useMemo(() => computeRisk(artifacts, reviews), [artifacts, reviews]);
  const radar = useMemo(() => buildAnalyticRadar(artifacts, risk.level, reviews), [artifacts, risk.level, reviews]);
  const groupDistribution = useMemo(() => buildGroupDistribution(artifacts), [artifacts]);
  const sourceDistribution = useMemo(() => buildSourceDistribution(artifacts), [artifacts]);
  const confidenceDistribution = useMemo(() => buildConfidenceDistribution(artifacts, reviews), [artifacts, reviews]);
  const sources = useMemo(() => uniqueSources(artifacts), [artifacts]);
  // Honest source depth: collapse mirrors/aggregators and same-corpus breach
  // fields so "3 copies of one leak" reads as ONE source, not three. See
  // src/lib/audit/from-artifacts.ts (unit-tested) + source-independence.ts.
  const auditSources = useMemo(() => artifactsToSources(artifacts), [artifacts]);
  const effectiveSources = useMemo(() => computeEffectiveSourceCount(auditSources), [auditSources]);
  const independenceFindings = useMemo(() => checkIndependence(auditSources), [auditSources]);
  // Honest confidence verdict: lint identity clusters for tier-over-statement /
  // unmet "Verified" gate, then roll lint + independence findings into one
  // CLEAN/ADVISORY/BLOCKED verdict. Integrity-critical (changes shown confidence).
  const clusterAudits = useMemo(() => artifactsToClusterAudit(artifacts, seedValue, reviews), [artifacts, seedValue, reviews]);
  const confidenceFindings = useMemo(() => lintReport(clusterAudits), [clusterAudits]);
  const verdict = useMemo(() => reportVerdict(confidenceFindings, independenceFindings), [confidenceFindings, independenceFindings]);
  const avgConfidence = useMemo(() => averageConfidence(artifacts, reviews), [artifacts, reviews]);

  const audit = buildToolAudit(artifacts);

  // The engine's accepted subject — the same selector CaseSheet reads. When
  // this is null the engine has refused to adopt a name (quarantined,
  // collision-flagged, or analyst-rejected), yet the model's prose below may
  // still assert one. The callout surfaces that disagreement at the top of
  // the report so the analyst doesn't have to compare against the Sheet.
  const engineSubject = useMemo(() => pickSubjectName(artifacts, reviews), [artifacts, reviews]);

  // Evidence-strength buckets per the new audit rules.
  const buckets = useMemo(() => {
    const g: Record<string, Artifact[]> = { confirmed: [], probable: [], lead: [], contradiction: [], excluded: [] };
    for (const a of artifacts) g[bucket(a, revOf(reviews, a))].push(a);
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
    <article id="case-report-print-root" className="case-report-doc text-data leading-relaxed text-foreground/95">
      {draftMark && <DraftMarking readinessPct={draftMark.readinessPct} reasons={draftMark.reasons} position="top" />}
      <VerdictBanner verdict={verdict} confCount={confidenceFindings.length} indepCount={independenceFindings.length} />
      {engineSubject === null && artifacts.length > 0 && (
        // Register item 10: reuse the Sheet's exact copy so a Report that
        // narrates a subject the engine has not accepted still shows the
        // engine's refusal in-line. The narrative notice on the chat prose
        // (ChatWindow.tsx) is per-message; this banner is per-report.
        <aside
          role="note"
          data-report-subject-refused
          className="mt-3 rounded-xl border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] px-4 py-3 text-data leading-snug text-foreground/90"
        >
          <div className="font-semibold text-[hsl(var(--warning))]">
            No established subject name.
          </div>
          <p className="mt-1 text-muted-foreground">
            No name holds for the subject yet. Quarantined and rejected names
            are never used here. Any name in the narrative below is model-written,
            not engine-adjudicated — reconcile against Evidence before adopting it.
          </p>
        </aside>
      )}
      {/* Header */}
      <header className="report-cover relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[hsl(var(--surface-1))/0.72] p-4 sm:p-5">
        <div className="relative z-10 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="text-eyebrow uppercase tracking-[0.22em] text-[hsl(var(--info))]">
              Case file / analytical report
            </div>
            <h2 className="mt-2 text-xl sm:text-2xl font-display font-semibold tracking-normal break-words [overflow-wrap:anywhere]">
              {display.title}
            </h2>
            <div className="mt-2 flex flex-wrap gap-1.5 text-eyebrow font-mono tracking-normal text-muted-foreground">
              <span className="px-2 py-1 border border-white/[0.08] rounded-lg bg-white/[0.035]">{display.kind}</span>
              <span className="px-2 py-1 border border-white/[0.08] rounded-lg bg-white/[0.035]">{reportType === "brief" ? "executive brief" : "full dossier"}</span>
              <span className="px-2 py-1 border border-white/[0.08] rounded-lg bg-white/[0.035]">{artifacts.length} artifacts</span>
              {/* Two populations, two words: calls are every recorded invocation;
                  "tools with artifacts" is distinct producing tools (buildToolAudit). */}
              {typeof toolCallTotal === "number" && (
                <span className="px-2 py-1 border border-white/[0.08] rounded-lg bg-white/[0.035]">{toolCallTotal} tool call{toolCallTotal === 1 ? "" : "s"}</span>
              )}
              <span className="px-2 py-1 border border-white/[0.08] rounded-lg bg-white/[0.035]">{audit.tools.length} tool{audit.tools.length === 1 ? "" : "s"} with artifacts</span>
              <span className="px-2 py-1 border border-white/[0.08] rounded-lg bg-white/[0.035]">{sources.length} sources</span>
              <span className="px-2 py-1 border border-white/[0.08] rounded-lg bg-white/[0.035]">{avgConfidence}% avg confidence</span>
            </div>
          </div>
          <div className={cn("shrink-0 rounded-2xl border px-4 py-3 text-right", RISK_COLOR[risk.level])}>
            <div className="text-micro font-mono tracking-normal text-muted-foreground">Risk posture</div>
            <div className="mt-1 font-display text-2xl font-semibold tracking-normal">{risk.level}</div>
          </div>
        </div>
      </header>

      <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ReportKpi label="Confirmed" value={buckets.confirmed.length} detail="verified or >=90 confidence" tone="ok" />
        <ReportKpi label="Probable" value={buckets.probable.length} detail="high-signal, needs final corroboration" tone="info" />
        <ReportKpi label="Leads" value={buckets.lead.length} detail="requires analyst verification" tone="warn" />
        <ReportKpi label="Contradictions" value={buckets.contradiction.length} detail="quality or conflict flags" tone={buckets.contradiction.length > 0 ? "danger" : "neutral"} />
      </section>
      {buckets.confirmed.length === 0 && artifacts.length > 0 && (
        <p className="mt-2 text-data leading-relaxed text-muted-foreground">
          A tier of <span className="font-mono text-foreground">0 confirmed</span> is by design, not an empty case: AI-inferred and
          single-source findings stay <span className="text-[hsl(var(--confidence-mid))]">leads</span> until a second independent source
          class corroborates them. The evidence below is real — it just hasn't cleared the confirmation bar yet.
        </p>
      )}

      {/* #499 — what the ENGINE adjudicated, directly under the KPIs so those
          numbers cannot be mistaken for an adjudication. "Confirmed" above is a
          source-tier label over ALL artifacts; this is the count of rows
          `record_finding` actually scored. On the production case that produced
          this issue the two were 0 and 0 while the model's prose claimed 90-95%
          CONFIRMED. Wording comes from authorityStatement so this panel and the
          markdown export cannot drift. */}
      {authority && (
        <section className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
          <div className="text-micro font-mono uppercase tracking-[0.18em] text-muted-foreground">
            {AUTHORITY_HEADING}
          </div>
          <p className="mt-1.5 text-data leading-relaxed text-muted-foreground">
            {authorityStatement(authority)}
          </p>
          {authority.findings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {authority.findings.map((f) => (
                <li key={f.id} className="flex items-baseline gap-2 text-data">
                  <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] text-foreground/90">{f.value}</span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    {typeof f.confidence === "number" ? `${f.confidence}%` : "n/a"}
                  </span>
                  <span className={cn("shrink-0 text-micro font-mono uppercase tracking-normal", tierInfo(f.confidence).text)}>
                    {tierInfo(f.confidence).label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Analyst confidence vs strict auto-corroboration — reconciles the
          "0 confirmed" metric with the reasoned identity read so they don't read
          as a contradiction. Display only; no scoring changed. */}
      <section className="mt-4 grid gap-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 sm:grid-cols-3">
        <div>
          <div className="text-micro font-mono tracking-normal text-muted-foreground">Analyst confidence</div>
          <div className="mt-1 font-display text-2xl font-semibold text-[hsl(var(--info))]">
            {analystConf}% <span className="text-sm font-mono tracking-normal text-muted-foreground">· {qualConfidence(analystConf)}</span>
          </div>
          <p className="mt-1 text-data leading-relaxed text-muted-foreground">Strongest identity-bearing artifact — reasoned read, not an auto-confirmation.</p>
        </div>
        <div>
          <div className="text-micro font-mono tracking-normal text-muted-foreground">Independently corroborated</div>
          <div className="mt-1 font-display text-2xl font-semibold text-foreground">{corroboratedCount} / {artifacts.length}</div>
          <p className="mt-1 text-data leading-relaxed text-muted-foreground">Findings backed by ≥2 independent source classes (same count as the Cross-source axis). Breach-only / single-class evidence stays a lead by design.</p>
        </div>
        <div>
          <div className="text-micro font-mono tracking-normal text-muted-foreground">Analyst-confirmed</div>
          <div className="mt-1 font-display text-2xl font-semibold text-foreground">{analystConfirmedCount}</div>
          <p className="mt-1 text-data leading-relaxed text-muted-foreground">A human vouched for these. Separate from corroboration: confirming a single-source row does not make it corroborated.</p>
        </div>
      </section>

      {/* Subject profile — always rendered so the dossier reads complete; an
          empty case shows an honest "nothing yet" line instead of vanishing. */}
      <SectionHeader>Subject Profile</SectionHeader>
      {subjectProfile.length > 0 || aliases.length > 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 grid gap-2 sm:grid-cols-2">
          {subjectProfile.map((f) => {
            const dobSuspect = /date of birth|dob/i.test(f.label) && isDobPlaceholder(f.value);
            return (
              <div key={f.label} className="flex flex-col">
                <span className="text-micro font-mono tracking-normal text-muted-foreground">{f.label}</span>
                <span className="font-mono text-foreground break-words [overflow-wrap:anywhere]">
                  {f.value}
                  {dobSuspect && (
                    <span
                      className="ml-2 align-middle rounded border border-[hsl(var(--warning))]/60 bg-[hsl(var(--warning))]/10 px-1.5 py-px text-micro font-mono uppercase tracking-wider text-[hsl(var(--warning))] no-underline"
                      title="January 1 is a common placeholder DOB — verify before relying on it"
                    >
                      placeholder?
                    </span>
                  )}
                </span>
                {f.note && (
                  <span className="mt-0.5 text-micro font-mono text-muted-foreground">{f.note}</span>
                )}
              </div>
            );
          })}
          {aliases.length > 0 && (
            <div className="flex flex-col sm:col-span-2">
              <span className="text-micro font-mono tracking-normal text-muted-foreground">Aliases / handles</span>
              <span className="font-mono text-foreground break-words [overflow-wrap:anywhere]">{aliases.join(", ")}</span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground italic text-data mt-2">No confirmed identity fields recovered yet.</p>
      )}

      {/* Digital footprint — clickable profiles/handles/domains. Surfaces the
          evidence that makes the report feel complete; presentation only.
          Omitted in the brief variant (like Breach Exposure / analytics). */}
      {!isBrief && profileLinks.length > 0 && (
        <>
          <SectionHeader>Digital Footprint</SectionHeader>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 grid gap-1.5 sm:grid-cols-2">
            {profileLinks.map((l) => (
              <div key={`${l.platform}|${l.value}`} className="flex items-baseline gap-2 min-w-0">
                <span className="shrink-0 text-eyebrow font-mono uppercase tracking-[0.12em] text-muted-foreground">{l.platform}</span>
                {l.href ? (
                  <a
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="min-w-0 truncate font-mono text-[hsl(var(--info))] underline decoration-dotted underline-offset-2 hover:decoration-solid"
                  >
                    {l.value}
                  </a>
                ) : (
                  <span className="min-w-0 truncate font-mono text-foreground break-words [overflow-wrap:anywhere]">{l.value}</span>
                )}
                {l.inferred && (
                  <span className="shrink-0 rounded border border-conf-possible/40 bg-conf-possible/10 px-1 py-px text-micro font-mono uppercase tracking-wider text-conf-possible">inferred</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Analyst narrative — latest assistant summary, ported from chat */}
      {narrative && (
        <>
          <SectionHeader>Analyst Narrative</SectionHeader>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 whitespace-pre-wrap leading-relaxed text-foreground/90">
            {narrative}
          </div>
        </>
      )}

      {!isBrief && (<>
      {/* Hybrid: prose dossier leads; the chart-heavy analytics live in a
          collapsible block so they don't dominate (esp. on mobile). */}
      <details className="mt-4 group rounded-xl border border-white/[0.08] bg-[hsl(var(--surface-1))/0.4]" open>
        <summary className="cursor-pointer list-none select-none px-3 py-2.5 flex items-center gap-2 text-meta font-mono font-semibold tracking-normal text-muted-foreground">
          <span className="transition-transform group-open:rotate-90" aria-hidden>▸</span>
          Analytics
          <span className="ml-auto text-eyebrow normal-case tracking-normal text-muted-foreground/70">descriptive — not scoring</span>
        </summary>
        <div className="px-3 pb-3 space-y-3">
      <section className="grid gap-3 xl:grid-cols-[1.05fr_0.95fr]">
        <ReportChartCard title="Analytic Radar" subtitle="Descriptive analytics, computed independently from the Confidence signals panel above.">
          <AnalyticRadar data={radar} />
        </ReportChartCard>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <ReportChartCard title="Evidence Groups" subtitle="Artifact distribution by investigation domain.">
            <CompactBarChart data={groupDistribution} />
          </ReportChartCard>
          <ReportChartCard title="Confidence Bands" subtitle="How strong the current artifact set is.">
            <CompactBarChart data={confidenceDistribution} color="hsl(var(--confidence-high))" />
          </ReportChartCard>
        </div>
      </section>

      <section className="mt-4 grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
        <ReportChartCard title="Source Coverage" subtitle="Top sources contributing artifacts to this report.">
          <CompactBarChart data={sourceDistribution} color="hsl(var(--brain-cyan))" />
        </ReportChartCard>
        <div className="rounded-xl border border-white/[0.08] bg-[hsl(var(--surface-1))/0.62] p-3">
          <div className="text-meta font-mono font-semibold tracking-normal text-muted-foreground">Radar Notes</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {radar.map((metric) => (
              <div key={metric.label} className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-data font-medium text-foreground">{metric.label}</span>
                  <span className="font-mono text-data text-[hsl(var(--info))]">{metric.value}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full rounded-full bg-[hsl(var(--info))]" style={{ width: `${metric.value}%` }} />
                </div>
                <p className="mt-1 text-data leading-relaxed text-muted-foreground">{metric.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
        </div>
      </details>

      <section className="mt-4 rounded-xl border border-[hsl(var(--info)/0.18)] bg-[hsl(var(--info)/0.055)] p-3">
        <div className="text-meta font-mono font-semibold tracking-normal text-[hsl(var(--info))]">
          Accuracy Guardrails
        </div>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          <GuardrailCard
            label="Breach / reputation"
            body="Breach, leak, and threat-reputation records display as manual-review evidence until independently corroborated."
          />
          <GuardrailCard
            label="Infrastructure"
            body="DNS, IP, and host data can verify an asset, but do not prove ownership or identity by themselves."
          />
          <GuardrailCard
            label="Source basis"
            body="Each table row includes source class, status basis, score, capture date, and backend reasoning where available."
          />
        </div>
        {(confidenceFindings.length > 0 || independenceFindings.length > 0) && (
          <ul className="mt-2.5 space-y-1.5 border-t border-[hsl(var(--info)/0.18)] pt-2.5">
            {confidenceFindings.map((f, i) => (
              <li
                key={`c${i}`}
                className={cn(
                  "flex items-start gap-1.5 text-data leading-relaxed",
                  f.severity === "error"
                    ? "text-[hsl(var(--danger))]"
                    : f.severity === "warn"
                      ? "text-[hsl(var(--warning))]"
                      : "text-muted-foreground",
                )}
              >
                <span aria-hidden className="mt-px shrink-0">{f.severity === "error" ? "⛔" : f.severity === "warn" ? "⚠" : "ℹ"}</span>
                <span>
                  <span className="font-medium">{f.cluster}:</span> {f.message}
                  {f.suggestion ? <span className="text-muted-foreground"> {f.suggestion}</span> : null}
                </span>
              </li>
            ))}
            {independenceFindings.map((f, i) => (
              <li
                key={`i${i}`}
                className={cn(
                  "flex items-start gap-1.5 text-data leading-relaxed",
                  f.severity === "warn" ? "text-[hsl(var(--warning))]" : "text-muted-foreground",
                )}
              >
                <span aria-hidden className="mt-px shrink-0">{f.severity === "warn" ? "⚠" : "ℹ"}</span>
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      </>)}

      {/* 1. Executive summary */}
      <SectionHeader>Executive Summary</SectionHeader>
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
        <p className="text-foreground/90">
          Investigation of <span className="font-mono">{display.selector}</span> produced{" "}
          {buckets.confirmed.length} confirmed, {buckets.probable.length} probable, and{" "}
          {buckets.lead.length} unverified leads across {effectiveSources} independent source
          {effectiveSources === 1 ? "" : "s"} (from {sources.length} raw source label
          {sources.length === 1 ? "" : "s"} after collapsing mirrors and duplicate datasets).{" "}
          {buckets.contradiction.length} contradiction
          {buckets.contradiction.length === 1 ? "" : "s"} were detected. Source-based confidence caps
          are applied conservatively: breach-only or aggregator-only evidence remains unconfirmed until
          independently corroborated.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <MiniAssessment label="Evidence volume" value={`${artifacts.length}`} hint="raw artifacts retained after client-side grouping" />
          <MiniAssessment label="Independent sources" value={`${effectiveSources}`} hint={`${sources.length} source label${sources.length === 1 ? "" : "s"} → ${effectiveSources} independent (mirrors & duplicate datasets collapsed)`} />
          <MiniAssessment label="Tools with artifacts" value={`${audit.tools.length}`} hint="tools represented in this case artifact set" />
        </div>
      </div>

      {/* 2. Safety / legal flags */}
      {safetyFlags.length > 0 && (
        <>
          <SectionHeader>Safety / Legal Flags</SectionHeader>
          <BucketTable rows={safetyFlags} empty="No safety flags." reviews={reviews} />
        </>
      )}

      {/* 3. Seed details */}
      <SectionHeader>Seed Details</SectionHeader>
      <div className="text-foreground/90 font-mono text-data">
        {display.kind} · {display.selector}
      </div>

      {/* Breach Exposure — masked credential indicators only (full dossier) */}
      {!isBrief && (breachRows.length > 0 ? (
        <>
          <SectionHeader>Breach Exposure</SectionHeader>
          <div className="rounded-md border border-border-subtle overflow-x-auto [scrollbar-width:thin]">
            <table className="w-full min-w-[640px] table-fixed [&_td]:align-top text-data">
              <thead>
                <tr className="bg-surface-2 text-micro font-medium tracking-normal text-muted-foreground">
                  <th className="text-left font-normal px-3 py-2 w-[26%]">Breach</th>
                  <th className="text-left font-normal px-3 py-2 w-[100px]">Date</th>
                  <th className="text-left font-normal px-3 py-2">Exposed fields</th>
                  <th className="text-left font-normal px-3 py-2 w-[220px]">Breach values</th>
                </tr>
              </thead>
              <tbody>
                {breachRows.map((b, i) => (
                  <tr key={i} className="border-t border-border-subtle">
                    <td className="px-3 py-2 break-words [overflow-wrap:anywhere]">
                      {b.site}
                      {b.severity && (
                        <span
                          className={cn(
                            "ml-2 align-middle rounded border px-1.5 py-px text-micro font-mono uppercase tracking-wider",
                            b.severity === "CRITICAL"
                              ? "border-destructive/50 bg-destructive/15 text-destructive"
                              : "border-[hsl(var(--warning))]/60 bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]",
                          )}
                          title="Full-profile / high-impact breach exposure"
                        >
                          {b.severity}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">{b.date || "—"}</td>
                    <td className="px-3 py-2 break-words">
                      {b.exposedFields.length ? (
                        <span className="flex flex-wrap gap-1">
                          {b.exposedFields.map((c) => (
                            <span key={c} className="rounded border border-border-subtle bg-surface-2 px-1.5 py-px text-eyebrow font-mono text-muted-foreground">{c}</span>
                          ))}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {b.minorRedacted ? (
                        <span
                          className="rounded border border-[hsl(var(--warning))]/60 bg-[hsl(var(--warning))]/10 px-1.5 py-px text-eyebrow font-mono uppercase tracking-wider text-[hsl(var(--warning))]"
                          title="Redacted — minor-safety hard stop. Not revealable."
                        >
                          redacted · minor-safety
                        </span>
                      ) : b.reveal.length ? (
                        <span className="flex flex-col items-start gap-1">
                          {b.reveal.map((r) => (
                            <MaskedValue key={r.label} label={r.label} value={r.value} />
                          ))}
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-data text-muted-foreground">
            {MASK_BREACH_VALUES ? (
              <>Breach values are masked by default — click <span className="font-mono text-destructive">Reveal</span> to unmask a captured value. Records flagged minor-related stay redacted and cannot be revealed.</>
            ) : (
              <>Captured breach values are shown in full. Records flagged minor-related stay redacted and are never shown. A dash means no concrete value was captured for that record — only the exposed field classes.</>
            )}
          </p>
        </>
      ) : (
        <>
          <SectionHeader>Breach Exposure</SectionHeader>
          <p className="text-muted-foreground italic text-data mt-2">No breach or credential-exposure records surfaced.</p>
        </>
      ))}

      {/* G-5 section 2: Supported observations.
          Umbrella header over the Confirmed / Probable / Leads buckets.
          The content below is the same `buckets.*` the previous flat
          structure rendered; the header gives JD's four-section
          vocabulary a visible anchor in the report.

          Important honest-data caveat (preserved from CLAUDE.md): the
          numbers inside these BucketTable rows are what `record_finding`
          persisted, not what the model's prose asserts. If a narrative
          elsewhere disagrees, trust these. */}
      <SectionHeader>Supported observations</SectionHeader>
      <p className="mt-1 mb-2 text-[12.5px] leading-snug text-muted-foreground">
        What the collected evidence supports today — from strongest (confirmed) to weakest (leads).
      </p>

      {/* 4. Confirmed findings */}
      <SectionHeader right={<StatusLegend />}>Confirmed Findings</SectionHeader>
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

      {/* G-5 section 3: Contradictions and gaps.
          The existing "Contradictions & Data Quality Problems" bucket is
          the content; the header rename matches the four-section vocabulary
          JD specified ("Executive summary · Supported observations ·
          Contradictions and gaps · Next investigative question"). */}
      {buckets.contradiction.length > 0 && (
        <>
          <SectionHeader>Contradictions and gaps</SectionHeader>
          <BucketTable rows={buckets.contradiction} empty="—" reviews={reviews} />
        </>
      )}

      {/* G-5 section 4: Next investigative question.
          The existing "Recommended Next Pivots" list is the content; the
          header asks the investigative question the pivots are proposed
          to answer. */}
      {nextPivots.length > 0 && (
        <>
          <SectionHeader>Next investigative question</SectionHeader>
          <p className="mt-1 mb-2 text-[12.5px] leading-snug text-muted-foreground">
            What should the next pivot establish? Each line is a target with its reason — ranked by expected case value, not record volume.
          </p>
          <ul className="space-y-1.5 list-disc pl-5 text-foreground/90 font-mono text-data">
            {nextPivots.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </>
      )}

      {/* Identity — always rendered with an honest empty state. */}
      <SectionHeader>Identity</SectionHeader>
      {identity.length > 0 ? (
          <div className="rounded-md border border-border-subtle overflow-hidden">
            <table className="w-full text-data">
              <thead>
                <tr className="bg-surface-2 text-micro font-medium tracking-normal text-muted-foreground">
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
      ) : (
        <p className="text-muted-foreground italic text-data mt-2">No identity fields extracted yet — investigation may be early or selectors unresolved.</p>
      )}

      {/* Hunter's notes (after identity, before registrations) */}
      {hunterNotes.slice(0, 2).map((n, i) => <HunterNote key={`hn-top-${i}`}>{n.text}</HunterNote>)}

      {/* Sensitive registrations */}
      {registrations.length > 0 && (
        <>
          <SectionHeader>Sensitive Registrations</SectionHeader>
          <div className="rounded-md border border-border-subtle overflow-hidden">
            <table className="w-full text-data">
              <thead>
                <tr className="bg-surface-2 text-micro font-medium tracking-normal text-muted-foreground">
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
                    <td className="px-3 py-2 text-muted-foreground text-data">
                      <SourceBadges sources={tokenizeSourceChain(r.source)} />
                    </td>
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
      <div className={cn("rounded-md border bg-surface-2 p-4", RISK_COLOR[risk.level])}>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-current" />
          <span className="px-2 py-0.5 rounded border border-current text-eyebrow font-mono uppercase tracking-[0.2em]">
            {risk.level}
          </span>
        </div>
        <div className="mt-3 text-micro tracking-normal text-muted-foreground">
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

      {!isBrief && (
        <>
          <SectionHeader>Methodology & Confidence Controls</SectionHeader>
          <div className="grid gap-3 lg:grid-cols-3">
            <MethodCard
              title="Evidence handling"
              body="Artifacts are separated with the conservative evidence-status layer used by the analyst UI. Confirmation requires strong source quality or corroboration."
            />
            <MethodCard
              title="Source weighting"
              body="Radar and charts are descriptive analytics. Shared-source dashed links, breach-only hits, and aggregator records should not be promoted without independent support."
            />
            <MethodCard
              title="Analyst action"
              body="Use recommended pivots and unknowns to close coverage gaps. Treat the chart scores as prioritization aids, not final attribution."
            />
          </div>
        </>
      )}
      {draftMark && <DraftMarking readinessPct={draftMark.readinessPct} reasons={draftMark.reasons} position="bottom" />}
    </article>
  );
}

function GuardrailCard({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/15 p-2">
      <div className="text-data font-semibold text-foreground">{label}</div>
      <p className="mt-1 text-data leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

const VERDICT_CFG: Record<ReportVerdict, { label: string; cls: string; note: string }> = {
  clean: {
    label: "CLEAN",
    cls: "border-[hsl(var(--confidence-high)/0.4)] bg-[hsl(var(--confidence-high)/0.08)] text-[hsl(var(--confidence-high))]",
    note: "No confidence over-statements or source-independence issues detected.",
  },
  advisory: {
    label: "ADVISORY",
    cls: "border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]",
    note: "Some findings read stronger than their evidence, or sources overlap — weigh the flags below before relying on the headline.",
  },
  blocked: {
    label: "BLOCKED",
    cls: "border-[hsl(var(--danger)/0.45)] bg-[hsl(var(--danger)/0.09)] text-[hsl(var(--danger))]",
    note: "A cluster declares a tier its evidence does not support (or claims “Verified” without ≥2 independent strong sources). Downgrade before relying on it.",
  },
};

/** Honest confidence verdict banner — CLEAN / ADVISORY / BLOCKED — driven by the
 *  confidence linter + source-independence findings. */
function VerdictBanner({ verdict, confCount, indepCount }: { verdict: ReportVerdict; confCount: number; indepCount: number }) {
  const cfg = VERDICT_CFG[verdict];
  const total = confCount + indepCount;
  return (
    <div className={cn("mb-3 flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5", cfg.cls)}>
      <span className="mt-0.5 inline-flex shrink-0 items-center rounded-md border border-current px-1.5 py-0.5 text-eyebrow font-mono font-bold uppercase tracking-[0.16em]">
        {cfg.label}
      </span>
      <div className="min-w-0">
        <div className="text-micro tracking-normal opacity-80">Confidence verdict</div>
        <p className="mt-0.5 text-data leading-relaxed text-foreground/85">
          {cfg.note}
          {total > 0 ? ` ${total} flag${total === 1 ? "" : "s"} in Accuracy Guardrails.` : ""}
        </p>
      </div>
    </div>
  );
}

function ReportKpi({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number | string;
  detail: string;
  tone: "neutral" | "ok" | "info" | "warn" | "danger";
}) {
  const toneClass =
    tone === "ok" ? "text-[hsl(var(--confidence-high))]" :
    tone === "info" ? "text-[hsl(var(--info))]" :
    tone === "warn" ? "text-[hsl(var(--confidence-mid))]" :
    tone === "danger" ? "text-destructive" :
    "text-foreground";
  return (
    <div className="report-kpi relative overflow-hidden rounded-xl border border-white/[0.08] bg-[hsl(var(--surface-1))/0.72] p-3">
      <div className="text-micro font-mono tracking-normal text-muted-foreground">{label}</div>
      <div className={cn("mt-2 font-display text-2xl font-semibold leading-none", toneClass)}>{value}</div>
      <div className="mt-2 text-data leading-relaxed text-muted-foreground">{detail}</div>
    </div>
  );
}

function MiniAssessment({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-2">
      <div className="text-micro font-mono tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg leading-none text-foreground">{value}</div>
      <div className="mt-1 text-data leading-relaxed text-muted-foreground">{hint}</div>
    </div>
  );
}

function MethodCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[hsl(var(--surface-1))/0.58] p-3">
      <div className="text-data font-semibold text-foreground">{title}</div>
      <p className="mt-1 text-data leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * The document marking for a report that is not report-safe — the case-file
 * equivalent of a classification line, set at the top and the bottom of the
 * document the way a marked page carries it on both ends. It is a statement
 * about the DOCUMENT, not a warning about a row, so it lives inside the print
 * root: Ctrl+P, the PDF button and a screenshot all carry it.
 */
function DraftMarking({ readinessPct, reasons, position }: { readinessPct: number; reasons: string[]; position: "top" | "bottom" }) {
  return (
    <div
      role={position === "top" ? "note" : undefined}
      aria-label={position === "top" ? `Unverified draft. Report readiness ${readinessPct} percent. Not report-safe.` : undefined}
      aria-hidden={position === "bottom" ? true : undefined}
      className={cn(
        "draft-mark flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md border border-[hsl(var(--warning)/0.5)] bg-[hsl(var(--warning)/0.07)] px-3 py-1.5 text-center font-mono text-data font-semibold uppercase tracking-[0.12em] text-[hsl(var(--warning))]",
        position === "top" ? "mb-3" : "mt-4",
      )}
      title={position === "top" ? reasons.join(" ") : undefined}
    >
      <span>Unverified draft</span>
      <span aria-hidden className="opacity-50">·</span>
      <span className="tabular-nums normal-case tracking-normal">Report readiness {readinessPct}%</span>
      <span aria-hidden className="opacity-50">·</span>
      <span>Not report-safe</span>
    </div>
  );
}
