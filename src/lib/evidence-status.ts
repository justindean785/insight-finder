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
 * This is a presentation layer ONLY. It is derived from the backend's own
 * source-class engine (`metadata.source_category` / `reason_not_confirmed`,
 * written by `applyEvidenceCaps`) and the existing integrity-critical
 * `labelForArtifact()`; it never invents confidence or promotes a finding.
 *
 * Conservative rules enforced here:
 *  - A single source can never display as "Verified".
 *  - Infrastructure-only corroboration reads as "Verified infrastructure"
 *    (asset exists/resolves) — never a generic "Verified" identity claim.
 *  - Breach/leak data surfaces as "Manual review", never confirmed.
 *  - VirusTotal / URLScan / EmailRep / IPQS read as "Threat/reputation",
 *    distinct from breach/exposure.
 *  - Shared/CDN hosts and reverse-IP collisions read as "Shared
 *    infrastructure — not ownership proof".
 */
export type EvidenceDisplayStatus =
  | "verified"
  | "verified_infrastructure"
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
  /** One-line evidence-basis subtext, e.g. "Single-source · registry". */
  basis: string;
  tone: EvidenceStatusTone;
  /** Tooltip / screen-reader explanation. */
  hint: string;
}

const STATUS_LABEL: Record<EvidenceDisplayStatus, string> = {
  verified: "Verified",
  verified_infrastructure: "Verified infrastructure",
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
  // Infrastructure corroboration is blue, not green — it confirms the asset,
  // not an identity/owner, so it must not read as a confirmed person finding.
  verified_infrastructure: "probable",
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
  verified_infrastructure: "Corroborated across multiple infrastructure sources — confirms the asset exists/resolves, NOT who owns or controls it.",
  probable: "Multiple signals point together but no definitive proof yet.",
  needs_corroboration: "Reported by a source but not independently corroborated. Verify before reporting.",
  manual_review: "Single-source breach/exposure, threat/reputation, or sensitive PII — requires analyst review, never auto-confirmed.",
  lead: "Low-confidence lead. Treat as a starting point, not a finding.",
  shared_infrastructure: "Shared/CDN host or reverse-IP collision — describes infrastructure, not ownership or identity.",
  contradicted: "Conflicts with the seed or another identity cluster.",
  rejected: "Marked as a false positive / unrelated entity.",
};

/** Friendly label for a backend SourceClass (or legacy/derived class token). */
const CLASS_LABEL: Record<string, string> = {
  infra_registry: "registry",
  infra_dns: "DNS",
  infra_scan: "scan",
  infra_reputation: "reputation",
  infra_passive: "passive DNS",
  infra_shared_host: "shared host",
  infra: "infrastructure",
  breach: "breach",
  ai_summary: "AI summary",
  username_sweep: "username sweep",
  social_profile_passive: "passive profile",
  social_profile_active: "profile",
  news: "news",
  court_record: "court record",
  official_profile_match: "official match",
  independent_public: "public page",
};

function classLabel(cls: string): string {
  return CLASS_LABEL[cls] ?? cls.replace(/_/g, " ");
}

/** Map the integrity-grade confidence label to the base analyst display status. */
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

/**
 * The artifact's source classes. Prefers the backend's authoritative
 * `metadata.source_category` (written by `applyEvidenceCaps`); falls back to a
 * coarse split of the raw source strings for legacy rows that predate it.
 */
function sourceClasses(a: Artifact): string[] {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const sc = meta.source_category;
  if (Array.isArray(sc) && sc.length > 0) {
    return Array.from(new Set(sc.map((s) => String(s))));
  }
  const metaSources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  const all = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  return Array.from(new Set(
    all.map((s) =>
      isBreachSource(s) ? "breach"
      : isUsernameSweepSource(s) ? "sweep"
      : s.toLowerCase().split(/[_:.]/)[0],
    ),
  ));
}

const SHARED_PROVIDER_RE = /cloudflare|akamai|fastly|amazon|aws\b|google\s*cloud|gcp\b|azure|shared\s*host/i;
const SHARED_SOURCE_RE = /reverse[\s._-]?ip|shared[\s._-]?host|co[\s._-]?hosted/i;
const REPUTATION_SOURCE_RE = /virustotal|urlscan|emailrep|ipqualityscore|ipqs|abuseipdb|reputation|threat/i;

/** True when the row describes shared/CDN infrastructure or a reverse-IP collision. */
export function isSharedInfrastructure(a: Artifact): boolean {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const kind = a.kind.toLowerCase();
  if (kind === "excluded_collision") return true;
  if (
    meta.shared_infra === true ||
    meta.shared_hosting === true ||
    meta.cdn === true ||
    meta.excluded_collision === true
  ) return true;
  // Network-layer artifacts hosted on a known shared/CDN provider are not
  // ownership proof (Cloudflare A records, reverse-IP neighbours, etc.).
  if (kind === "ip" || kind === "infrastructure" || kind === "domain" || kind === "subdomain") {
    const providerText = ["provider", "org", "asn_org", "as_name", "isp", "asn"]
      .map((k) => meta[k])
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    if ((kind === "ip" || kind === "infrastructure") && SHARED_PROVIDER_RE.test(providerText)) return true;
  }
  if (SHARED_SOURCE_RE.test(a.source ?? "")) return true;
  const sc = sourceClasses(a);
  if (sc.includes("infra_shared_host")) return true;
  return false;
}

/** True when the row is a threat/reputation signal (distinct from a breach). */
function isReputationEvidence(a: Artifact, classes: string[]): boolean {
  const kind = a.kind.toLowerCase();
  if (kind === "threat_reputation" || kind === "reputation_signal") return true;
  if (classes.includes("infra_reputation")) return true;
  return REPUTATION_SOURCE_RE.test(a.source ?? "");
}

/**
 * Resolve the analyst-facing status + evidence basis for an artifact.
 * `review` is the optional local analyst review state (confirmed/dismissed/…).
 */
export function evidenceStatus(a: Artifact, review?: ReviewAdjustment): EvidenceStatusInfo {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const label = labelForArtifact(a, review);
  const classes = sourceClasses(a);
  const infraClasses = classes.filter((c) => c.startsWith("infra") && c !== "infra_shared_host");
  const nonInfra = classes.filter((c) => !c.startsWith("infra"));
  const infraOnly = nonInfra.length === 0 && infraClasses.length > 0;
  const multi = classes.length >= 2;
  const kind = a.kind.toLowerCase();

  const metaSources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  const allSources = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  const reputation = isReputationEvidence(a, classes);
  const breachRelated =
    !reputation &&
    (kind === "breach" || kind === "breach_exposure" ||
      classes.includes("breach") ||
      (allSources.length > 0 && allSources.some((s) => isBreachSource(s))));
  const analystConfirmed = review === "confirmed" || review === "key";
  const shared = isSharedInfrastructure(a);

  let status: EvidenceDisplayStatus;
  if (label === "FAILED") {
    status = "rejected";
  } else if (shared) {
    status = "shared_infrastructure";
  } else if (label === "CONFLICT") {
    status = "contradicted";
  } else {
    let base = statusFromLabel(label);
    if (analystConfirmed) {
      base = "verified";
    } else if (reputation && (base === "verified" || base === "probable" || base === "needs_corroboration" || base === "lead")) {
      // Threat/reputation signals are review-only — never auto-confirmed.
      base = "manual_review";
    } else if (breachRelated && (base === "probable" || base === "needs_corroboration" || base === "lead")) {
      base = "manual_review";
    } else if (infraOnly && (base === "verified" || base === "probable")) {
      // Infra-only never displays as a confirmed identity/owner finding.
      base = "verified_infrastructure";
    }
    status = base;
  }

  // Evidence-basis subtext.
  let basis: string;
  if (status === "shared_infrastructure") {
    basis = "Shared infrastructure · not ownership proof";
  } else if (status === "rejected") {
    basis = "Excluded from findings";
  } else if (status === "verified_infrastructure") {
    basis = "Infrastructure-only · not ownership proof";
  } else if (reputation && status === "manual_review") {
    basis = `Threat/reputation signal · ${multi ? "multi-source" : "single-source"}`;
  } else if (breachRelated && status === "manual_review") {
    basis = `Breach/exposure · ${multi ? "multi-source" : "single-source"}`;
  } else {
    const cls = classLabel(classes[0] ?? "unknown");
    basis = `${multi ? "Multi-source" : "Single-source"} · ${cls}`;
  }

  // Prefer the backend's own reason text when it added detail.
  const backendReason = typeof meta.reason_not_confirmed === "string" ? meta.reason_not_confirmed : "";
  const hint = backendReason && status !== "verified"
    ? `${STATUS_HINT[status]} (${backendReason})`
    : STATUS_HINT[status];

  return { status, label: STATUS_LABEL[status], basis, tone: STATUS_TONE[status], hint };
}

export const EVIDENCE_STATUS_ORDER: EvidenceDisplayStatus[] = [
  "verified",
  "verified_infrastructure",
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
  verified_infrastructure: 1,
  probable: 2,
  manual_review: 3,
  needs_corroboration: 4,
  contradicted: 5,
  lead: 6,
  shared_infrastructure: 7,
  rejected: 8,
};
