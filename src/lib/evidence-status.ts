import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  labelForArtifact,
  isBreachSource,
  isUsernameSweepSource,
  type ConfLabel,
  type ReviewAdjustment,
} from "@/lib/intel";

/**
 * Analyst-facing evidence status — a *textual* label (never color alone) that
 * makes the strength of a finding obvious at a glance and keeps weak/single-
 * source data visually restrained.
 *
 * This is a presentation layer ONLY. It is derived from the existing
 * integrity-critical `labelForArtifact()` confidence engine plus metadata
 * flags; it never invents confidence or promotes a finding. The mapping is
 * deliberately conservative: a single source can never display as "Verified",
 * breach/leak data surfaces as "Manual review", and shared-infrastructure /
 * collision rows are called out as "Shared infrastructure — not ownership
 * proof" so they can't be mistaken for a confirmed link.
 */
export type EvidenceDisplayStatus =
  | "verified"
  | "probable"
  | "needs_corroboration"
  | "manual_review"
  | "lead"
  | "shared_infrastructure"
  | "contradicted"
  | "rejected";

export type EvidenceStatusTone = "ok" | "probable" | "warn" | "muted" | "danger";

export interface EvidenceStatusInfo {
  status: EvidenceDisplayStatus;
  /** Short chip text, e.g. "Needs corroboration". */
  label: string;
  /** One-line evidence-basis subtext, e.g. "Single-source · infrastructure". */
  basis: string;
  tone: EvidenceStatusTone;
  /** Tooltip / screen-reader explanation. */
  hint: string;
}

const STATUS_LABEL: Record<EvidenceDisplayStatus, string> = {
  verified: "Verified",
  probable: "Probable",
  needs_corroboration: "Needs corroboration",
  manual_review: "Manual review",
  lead: "Lead",
  shared_infrastructure: "Shared infrastructure",
  contradicted: "Contradicted",
  rejected: "Rejected",
};

const STATUS_TONE: Record<EvidenceDisplayStatus, EvidenceStatusTone> = {
  verified: "ok",
  probable: "probable",
  needs_corroboration: "warn",
  manual_review: "warn",
  lead: "muted",
  shared_infrastructure: "muted",
  contradicted: "danger",
  rejected: "danger",
};

const STATUS_HINT: Record<EvidenceDisplayStatus, string> = {
  verified: "Corroborated by ≥2 independent source classes or analyst-confirmed.",
  probable: "Multiple signals point together but no definitive proof yet.",
  needs_corroboration: "Reported by a source but not independently corroborated. Verify before reporting.",
  manual_review: "Single-source breach/exposure or sensitive PII — requires analyst review, never auto-confirmed.",
  lead: "Low-confidence lead. Treat as a starting point, not a finding.",
  shared_infrastructure: "Shared/CDN host or reverse-IP collision — describes infrastructure, not ownership or identity.",
  contradicted: "Conflicts with the seed or another identity cluster.",
  rejected: "Marked as a false positive / unrelated entity.",
};

/** Map the integrity-grade confidence label to the analyst display status. */
function statusFromLabel(label: ConfLabel): EvidenceDisplayStatus {
  switch (label) {
    case "CONFIRMED": return "verified";
    case "CORRELATED": return "probable";
    case "INFERRED": return "needs_corroboration";
    case "VERIFY": return "needs_corroboration";
    case "CONFLICT": return "contradicted";
    case "FAILED": return "rejected";
    case "LOW": return "lead";
    default: return "lead";
  }
}

function distinctSourceClasses(a: Artifact): string[] {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const metaSources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  const all = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  const classes = new Set(
    all.map((s) =>
      isBreachSource(s) ? "breach"
      : isUsernameSweepSource(s) ? "sweep"
      : s.toLowerCase().split(/[_:.]/)[0],
    ),
  );
  return [...classes];
}

/** True when the row describes shared/CDN infrastructure or a reverse-IP collision. */
export function isSharedInfrastructure(a: Artifact): boolean {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  return (
    a.kind.toLowerCase() === "excluded_collision" ||
    meta.shared_hosting === true ||
    meta.excluded_collision === true
  );
}

/**
 * Resolve the analyst-facing status + evidence basis for an artifact.
 * `review` is the optional local analyst review state (confirmed/dismissed/…).
 */
export function evidenceStatus(a: Artifact, review?: ReviewAdjustment): EvidenceStatusInfo {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const label = labelForArtifact(a, review);
  const classes = distinctSourceClasses(a);
  const multi = classes.length >= 2;
  const kind = a.kind.toLowerCase();

  const metaSources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  const allSources = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  const breachRelated =
    kind === "breach" ||
    (allSources.length > 0 && allSources.some((s) => isBreachSource(s)));

  let status = statusFromLabel(label);

  // Overrides (most specific first) — these never *raise* strength.
  if (status !== "rejected" && status !== "contradicted" && isSharedInfrastructure(a)) {
    status = "shared_infrastructure";
  } else if (
    breachRelated &&
    (status === "needs_corroboration" || status === "lead" || status === "probable")
  ) {
    // Single-source breach/exposure data is manual-review only, never confirmed.
    status = "manual_review";
  }

  // Evidence-basis subtext.
  let basis: string;
  if (status === "shared_infrastructure") {
    basis = "Shared infrastructure · not ownership proof";
  } else if (status === "rejected") {
    basis = "Excluded from findings";
  } else if (breachRelated && status === "manual_review") {
    basis = multi ? "Breach/exposure · multi-source" : "Breach/exposure · single-source";
  } else {
    const cls = classes[0] ?? "unknown";
    basis = `${multi ? "Multi-source" : "Single-source"} · ${cls}`;
  }

  return {
    status,
    label: STATUS_LABEL[status],
    basis,
    tone: STATUS_TONE[status],
    hint: STATUS_HINT[status],
  };
}

export const EVIDENCE_STATUS_ORDER: EvidenceDisplayStatus[] = [
  "verified",
  "probable",
  "needs_corroboration",
  "manual_review",
  "lead",
  "shared_infrastructure",
  "contradicted",
  "rejected",
];

/** Sort weight so the strongest, most actionable evidence surfaces first. */
export const EVIDENCE_STATUS_RANK: Record<EvidenceDisplayStatus, number> = {
  verified: 0,
  probable: 1,
  manual_review: 2,
  needs_corroboration: 3,
  contradicted: 4,
  lead: 5,
  shared_infrastructure: 6,
  rejected: 7,
};
