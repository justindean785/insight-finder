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
  const v = a.metadata?.[key];
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

  // Conflicting person names — the #1 false-merge signal for identity work.
  // If a cluster carries two or more distinct full names (e.g. one handle that
  // resolves to "John Daniels" on GitHub but "John Demos" on Twitter), that is
  // strong evidence two different people share the selector.
  const names = artifacts.filter((a) => a.kind === "name" && a.value.trim());
  const distinctNames = new Set(names.map((a) => a.value.trim().toLowerCase()));
  if (distinctNames.size > 1) {
    out.push({
      kind: "name_conflict",
      detail: `${distinctNames.size} distinct names across profiles: ${names.map((a) => a.value.trim()).join(" vs ")} — likely different people on the same selector`,
      involved: names.map((a) => a.value),
      severity: "high",
    });
  }

  // Over-broad username — a handle "confirmed" on an implausible number of
  // platforms is almost certainly a generic/non-unique handle (squatted or
  // coincidental), not one identity. Reads the sweep's own platform count.
  const OVER_BROAD_PLATFORM_COUNT = 15;
  for (const a of artifacts) {
    if (a.kind !== "username" && a.kind !== "social") continue;
    const meta = a.metadata ?? {};
    const count = typeof meta.platforms_confirmed === "number"
      ? meta.platforms_confirmed
      : Array.isArray(meta.primary_platforms)
      ? meta.primary_platforms.length
      : 0;
    if (count >= OVER_BROAD_PLATFORM_COUNT) {
      out.push({
        kind: "over_broad_username",
        detail: `username "${a.value}" appears on ${count} platforms — almost certainly a generic/non-unique handle, not a single identity`,
        involved: [a.value],
        severity: "medium",
      });
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
    const rawBreachDate = a.metadata?.breach_date;
    const breachDate = typeof rawBreachDate === "string" ? rawBreachDate : undefined;
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
