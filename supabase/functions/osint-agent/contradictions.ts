// Lightweight contradiction detector. Given a candidate identity cluster
// (list of artifacts), surface conflicts that should reduce confidence
// before the orchestrator promotes a finding.

export interface ContradictionFinding {
  kind: string;             // e.g. "location_conflict"
  detail: string;
  involved: string[];       // artifact values involved
  severity: "low" | "medium" | "high";
  /** The attribute in conflict (e.g. "location", "employer", "name"). Present
   *  only on findings backed by EXPLICIT conflicting attribute claims — these
   *  are the only ones eligible to be structured into `metadata.contradictions`.
   *  Advisory/heuristic findings (thin_name, common_handle, cdn_shared_infra,
   *  over_broad_username, stale_breach) intentionally omit it. */
  field?: string;
  /** The conflicting attribute claims, each with its originating source, so the
   *  structured record can explain prior-value / conflicting-value + source(s). */
  claims?: Array<{ value: string; source: string | null }>;
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

/** Return the first present, non-empty RAW (case-preserving) metadata string
 *  among `keys`. Used to build human-readable conflicting-claim records. */
function rawMetaStr(a: ArtifactLike, keys: string[]): string | null {
  for (const k of keys) {
    const v = a.metadata?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// Metadata keys that carry an EXPLICIT current-location claim. The original
// detector only read location/city/country, but the orchestrator records a
// subject's location under `based` / `residence` too — so a real
// LA-vs-Tampa conflict was invisible. `birthplace` is deliberately excluded:
// it is not a current-location claim and would manufacture false conflicts
// against `residence`.
const LOCATION_META_KEYS = [
  "location", "city", "country", "based", "based_in", "residence", "residence_city", "current_city",
];
const EMPLOYER_META_KEYS = ["employer", "company"];

export function detectContradictions(artifacts: ArtifactLike[]): ContradictionFinding[] {
  const out: ContradictionFinding[] = [];

  // Location conflict — reads the keys the orchestrator actually writes
  // (`based`/`residence`/…), capturing each claim's source so the conflict can
  // be structured rather than buried in prose.
  const locClaims = artifacts
    .map((a) => ({ a, loc: rawMetaStr(a, LOCATION_META_KEYS) }))
    .filter((x): x is { a: ArtifactLike; loc: string } => !!x.loc);
  const distinctLocs = new Set(locClaims.map((x) => x.loc.toLowerCase()));
  if (distinctLocs.size > 1) {
    out.push({
      kind: "location_conflict",
      field: "location",
      detail: `${distinctLocs.size} distinct locations across artifacts: ${[...new Set(locClaims.map((x) => x.loc))].join(", ")}`,
      involved: locClaims.map((x) => x.a.value),
      claims: locClaims.map((x) => ({ value: x.loc, source: x.a.source ?? null })),
      severity: "high",
    });
  }

  // Employer conflict
  const employerClaims = artifacts
    .map((a) => ({ a, emp: rawMetaStr(a, EMPLOYER_META_KEYS) }))
    .filter((x): x is { a: ArtifactLike; emp: string } => !!x.emp);
  const distinctEmployers = new Set(employerClaims.map((x) => x.emp.toLowerCase()));
  if (distinctEmployers.size > 1) {
    out.push({
      kind: "employer_conflict",
      field: "employer",
      detail: `multiple employers seen: ${[...new Set(employerClaims.map((x) => x.emp))].join(", ")}`,
      involved: employerClaims.map((x) => x.a.value),
      claims: employerClaims.map((x) => ({ value: x.emp, source: x.a.source ?? null })),
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
      field: "name",
      detail: `${distinctNames.size} distinct names across profiles: ${names.map((a) => a.value.trim()).join(" vs ")} — likely different people on the same selector`,
      involved: names.map((a) => a.value),
      claims: names.map((a) => ({ value: a.value.trim(), source: a.source ?? null })),
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

// ---------------------------------------------------------------------------
// Structured persistence — turn detected conflicts that carry EXPLICIT
// conflicting attribute claims into objects suitable for an artifact's
// `metadata.contradictions[]`, so the conflict is represented structurally
// instead of surviving only as prose in `metadata.note`.
//
// Pure + deterministic (caller supplies `nowIso`) so it is trivially testable
// without a database. The thin DB glue in the `detect_contradictions` tool
// merges these onto the involved artifacts.
// ---------------------------------------------------------------------------

export interface StructuredContradiction {
  /** The detector finding kind, e.g. "location_conflict". */
  kind: string;
  /** Attribute in conflict, e.g. "location". */
  field: string;
  /** Human-readable reason. */
  reason: string;
  severity: "low" | "medium" | "high";
  /** The conflicting claims, each with its originating source. Captures both
   *  the prior value and the new/conflicting value(s). */
  claims: Array<{ value: string; source: string | null }>;
  detected_at: string;
}

export interface ContradictionPatch {
  /** Artifact value the entry should be attached to. */
  value: string;
  entry: StructuredContradiction;
}

/**
 * Build the per-artifact structured-contradiction patches for a cluster.
 * Only findings carrying explicit conflicting attribute claims (`field` +
 * ≥2 `claims`) are emitted — advisory single-artifact heuristics are skipped,
 * honoring "only structure contradictions when there are explicit conflicting
 * attribute claims".
 */
export function structuredContradictionPatches(
  artifacts: ArtifactLike[],
  nowIso: string,
): ContradictionPatch[] {
  const findings = detectContradictions(artifacts);
  const patches: ContradictionPatch[] = [];
  for (const f of findings) {
    if (!f.field || !f.claims || f.claims.length < 2) continue;
    const entry: StructuredContradiction = {
      kind: f.kind,
      field: f.field,
      reason: f.detail,
      severity: f.severity,
      claims: f.claims,
      detected_at: nowIso,
    };
    // De-dup involved values: one entry per affected artifact value.
    for (const value of new Set(f.involved)) {
      patches.push({ value, entry });
    }
  }
  return patches;
}

/**
 * Cluster-scoped variant of structuredContradictionPatches.
 *
 * A contradiction (e.g. a location conflict) is only real WITHIN a single
 * candidate identity — two different people in a multi-hypothesis thread
 * legitimately have different locations/employers and must NOT be marked as
 * contradicting each other. So we group by `metadata.cluster_id` and detect
 * conflicts only within each explicitly-assigned cluster. Artifacts with no
 * cluster_id are NOT auto-persisted (we can't assert they're the same entity);
 * the thread-wide advisory `detectContradictions()` result is unaffected.
 */
export function clusterScopedContradictionPatches(
  artifacts: ArtifactLike[],
  nowIso: string,
): ContradictionPatch[] {
  const groups = new Map<string, ArtifactLike[]>();
  for (const a of artifacts) {
    const cid = a.metadata?.cluster_id;
    if (typeof cid !== "string" || !cid.trim()) continue; // unclustered → not same-entity
    const key = cid.trim();
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }
  const out: ContradictionPatch[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    out.push(...structuredContradictionPatches(group, nowIso));
  }
  return out;
}

/** True when two structured contradictions describe the same conflict
 *  (same finding kind + same attribute). Used for idempotent merging. */
function sameContradiction(a: unknown, b: StructuredContradiction): boolean {
  if (!a || typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  return o.kind === b.kind && o.field === b.field;
}

/**
 * Merge new structured contradictions into an artifact's existing
 * `metadata.contradictions[]`, preserving any prior entries (including legacy
 * string entries the model supplied) and skipping duplicates. Returns a NEW
 * array; never mutates the input.
 */
export function mergeStructuredContradictions(
  existing: unknown[],
  incoming: StructuredContradiction[],
): unknown[] {
  const out = [...existing];
  for (const entry of incoming) {
    if (out.some((e) => sameContradiction(e, entry))) continue;
    out.push(entry);
  }
  return out;
}
