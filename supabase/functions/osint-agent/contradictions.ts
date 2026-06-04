// Lightweight contradiction detector. Given a candidate identity cluster
// (list of artifacts), surface conflicts that should reduce confidence
// before the orchestrator promotes a finding.

export interface ContradictionFinding {
  kind: string;             // e.g. "location_conflict"
  detail: string;
  involved: string[];       // artifact values involved
  severity: "low" | "medium" | "high";
}

interface ArtifactLike {
  kind: string;
  value: string;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
}

const COMMON_HANDLES = new Set([
  "admin", "john", "alex", "michael", "david", "chris", "sarah", "test", "user",
  "info", "support", "mike", "james", "andrew", "ryan", "kevin", "anna",
]);

const CDN_NETS = ["cloudflare", "akamai", "fastly", "amazonaws", "googleuser", "azureedge", "cloudfront"];

function metaStr(a: ArtifactLike, key: string): string | null {
  const v = (a.metadata as any)?.[key];
  return typeof v === "string" ? v.toLowerCase() : null;
}

export function detectContradictions(artifacts: ArtifactLike[]): ContradictionFinding[] {
  const out: ContradictionFinding[] = [];

  // Location conflict
  const locs = artifacts
    .map((a) => ({ a, loc: metaStr(a, "location") || metaStr(a, "city") || metaStr(a, "country") }))
    .filter((x) => x.loc);
  const distinctLocs = new Set(locs.map((x) => x.loc!));
  if (distinctLocs.size > 1) {
    out.push({
      kind: "location_conflict",
      detail: `${distinctLocs.size} distinct locations across artifacts: ${[...distinctLocs].join(", ")}`,
      involved: locs.map((x) => x.a.value),
      severity: "high",
    });
  }

  // Employer / name conflict
  const employers = new Set(
    artifacts.map((a) => metaStr(a, "employer") || metaStr(a, "company")).filter(Boolean) as string[],
  );
  if (employers.size > 1) {
    out.push({
      kind: "employer_conflict",
      detail: `multiple employers seen: ${[...employers].join(", ")}`,
      involved: artifacts.filter((a) => metaStr(a, "employer") || metaStr(a, "company")).map((a) => a.value),
      severity: "medium",
    });
  }

  // Common-handle / common-name collision risk
  for (const a of artifacts) {
    if (a.kind === "username" && COMMON_HANDLES.has(a.value.toLowerCase())) {
      out.push({
        kind: "common_handle_collision",
        detail: `username "${a.value}" is extremely common — same-handle ≠ same-person`,
        involved: [a.value],
        severity: "medium",
      });
    }
    if (a.kind === "name") {
      const parts = a.value.trim().split(/\s+/);
      if (parts.length < 2) {
        out.push({
          kind: "thin_name",
          detail: `single-token name "${a.value}" — high same-name collision risk`,
          involved: [a.value],
          severity: "low",
        });
      }
    }
  }

  // CDN / shared infra false-link
  for (const a of artifacts) {
    if (a.kind === "ip") {
      const asn = metaStr(a, "asn_org") || metaStr(a, "isp") || metaStr(a, "org") || "";
      if (CDN_NETS.some((c) => asn.includes(c))) {
        out.push({
          kind: "cdn_shared_infra",
          detail: `IP ${a.value} resolves to a shared CDN (${asn}) — not origin-owned`,
          involved: [a.value],
          severity: "high",
        });
      }
    }
  }

  // Stale breach data (>5y) being treated as live identity signal
  const fiveYearsAgoMs = Date.now() - 5 * 365 * 24 * 3600 * 1000;
  for (const a of artifacts) {
    const breachDate = (a.metadata as any)?.breach_date as string | undefined;
    if (breachDate) {
      const t = Date.parse(breachDate);
      if (!Number.isNaN(t) && t < fiveYearsAgoMs) {
        out.push({
          kind: "stale_breach",
          detail: `breach data older than 5 years (${breachDate}) — credentials/identity may be outdated`,
          involved: [a.value],
          severity: "low",
        });
      }
    }
  }

  return out;
}
