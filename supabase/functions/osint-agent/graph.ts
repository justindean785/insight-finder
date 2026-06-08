/**
 * graph.ts — pure entity-graph core for graph-first OSINT reasoning.
 *
 * Phase-1 foundation of the next-gen investigation engine. This module is
 * deliberately PURE and ADDITIVE: it has no Deno/npm imports, performs no I/O,
 * and is NOT yet wired into the orchestrator. It turns the flat artifact list
 * the engine already produces into canonical entity nodes so later PRs can do
 * confidence propagation (Phase 2), cluster splitting (Phase 3), and
 * cheapest-justified-pivot selection (Phase 9) on a real graph instead of a
 * stream of artifacts.
 *
 * Covered here: node/edge model (Phase 1), generic-handle detection (Phase 4),
 * dead-end detection (Phase 5), and the source-class confidence model
 * (Phase 10). Edge inference + propagation + clustering land in the next PR.
 */

// ---- Model ------------------------------------------------------------------

export type NodeType =
  | "person"
  | "username"
  | "email"
  | "phone"
  | "domain"
  | "ip"
  | "organization"
  | "social_profile"
  | "infrastructure"
  | "breach_artifact"
  | "file"
  | "url";

// Reserved for PR #8 (edge inference + propagation). Declared now so the model
// is stable and downstream code can type against it.
export type EdgeType =
  | "owns"
  | "uses"
  | "registered_to"
  | "same_selector"
  | "same_breach"
  | "same_domain"
  | "same_ip"
  | "works_for"
  | "alias_of"
  | "contradicts"
  | "supports"
  | "mentions"
  | "derived_from";

export type SourceClass =
  | "official"
  | "government"
  | "news"
  | "corporate"
  | "social"
  | "breach"
  | "username_sweep"
  | "marketing"
  | "generic"
  | "unknown";

/** Phase 10 source weights. Identity confidence scales with the strongest
 *  independent source class corroborating a node. */
export const SOURCE_CLASS_WEIGHT: Record<SourceClass, number> = {
  official: 100,
  government: 95,
  news: 85,
  corporate: 75,
  social: 65,
  breach: 55,
  username_sweep: 45,
  marketing: 30,
  generic: 20,
  unknown: 35,
};

/** A handle confirmed on at least this many platforms is treated as over-broad
 *  (squatted / dictionary handle), not a single identity. Matches the
 *  `over_broad_username` threshold already used by contradictions.ts. */
export const GENERIC_HANDLE_MIN_PLATFORMS = 15;

export interface NodeEvidence {
  source: string;
  sourceClass: SourceClass;
  weight: number;
  confidence: number;
  timestamp: string | null;
  investigationId: string | null;
}

export type NodeStatus = "active" | "exhausted" | "inferred" | "needs_review";

export interface GraphNode {
  /** stable id: `${type}:${normalizedValue}` — also the dedup key */
  id: string;
  type: NodeType;
  /** normalized selector (dedup key minus the type prefix) */
  value: string;
  /** first-seen original value, for display */
  raw: string;
  evidence: NodeEvidence[];
  metadata: Record<string, unknown>;
}

/** Loose shape of the artifacts the engine already emits (export JSON / the
 *  app's Artifact type). Everything but value/kind is optional. */
export interface ArtifactInput {
  kind?: string | null;
  value?: string | null;
  confidence?: number | null;
  source?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ---- Classification & normalization ----------------------------------------

/** Map an artifact's source_category / source string to a SourceClass. */
export function classifySource(category: string | null | undefined): SourceClass {
  const c = (category ?? "").toLowerCase().trim();
  if (!c) return "unknown";
  if (c.includes("official") || c.includes("gov_record")) return "official";
  if (c.includes("government")) return "government";
  if (c.includes("news")) return "news";
  if (c.includes("corporate") || c.includes("company")) return "corporate";
  if (c.includes("marketing")) return "marketing";
  if (c.includes("social")) return "social";
  if (c.includes("breach") || c.includes("leak")) return "breach";
  if (c.includes("username_sweep") || c.includes("sweep")) return "username_sweep";
  if (c.includes("generic")) return "generic";
  // infra / independent_public / unknown → conservative
  return "unknown";
}

/** Pick the strongest SourceClass across an artifact's source_category[]. */
export function strongestSourceClass(categories: unknown): SourceClass {
  const list = Array.isArray(categories) ? categories : [categories];
  let best: SourceClass = "unknown";
  for (const c of list) {
    const cls = classifySource(typeof c === "string" ? c : null);
    if (SOURCE_CLASS_WEIGHT[cls] > SOURCE_CLASS_WEIGHT[best]) best = cls;
  }
  return best;
}

/** Classify one artifact, trusting the honest source/note over an optimistic
 *  category. Contamination dominates: data drawn from a marketing leak is
 *  `marketing` even if it was filed under `official_profile_match` — the exact
 *  inflation the audit caught (Apollo.io marketing PII scored as official). */
export function classifyArtifact(a: ArtifactInput): SourceClass {
  const note = typeof a.metadata?.note === "string" ? a.metadata.note : "";
  const hay = `${a.source ?? ""} ${note}`.toLowerCase();
  if (hay.includes("marketing")) return "marketing";
  return strongestSourceClass(a.metadata?.source_category ?? a.metadata?.sources ?? null);
}

const URL_RE = /^https?:\/\//i;

/** Canonicalize a selector so the same entity collapses to one node. */
export function normalizeSelector(type: NodeType, value: string): string {
  const v = (value ?? "").trim();
  switch (type) {
    case "email":
      return v.toLowerCase();
    case "username":
    case "social_profile": {
      // strip @, or take the last path segment of a profile URL
      let s = v.replace(/^@/, "");
      if (URL_RE.test(s)) {
        s = s.replace(URL_RE, "").replace(/[?#].*$/, ""); // drop protocol + query/hash
        s = s.split("/").filter(Boolean).pop() ?? s;       // last path segment
      }
      return s.toLowerCase();
    }
    case "domain":
      return v.toLowerCase().replace(URL_RE, "").replace(/[/?#].*$/, "");
    case "phone":
      return v.replace(/[^\d+]/g, "");
    case "person":
    case "organization":
      return v.toLowerCase().replace(/\s+/g, " ");
    default:
      return v;
  }
}

/** Infer a NodeType from an artifact kind (with a value fallback for the
 *  engine's loose kinds: case / weak_lead / other). */
export function inferNodeType(kind: string | null | undefined, value: string): NodeType {
  const k = (kind ?? "").toLowerCase().trim();
  switch (k) {
    case "name":
    case "person": return "person";
    case "username":
    case "handle": return "username";
    case "social":
    case "social_profile": return "social_profile";
    case "email": return "email";
    case "phone": return "phone";
    case "domain":
    case "subdomain": return "domain";
    case "ip": return "ip";
    case "organization":
    case "org": return "organization";
    case "infrastructure": return "infrastructure";
    case "breach":
    case "breach_artifact": return "breach_artifact";
    case "file": return "file";
    case "url": return "url";
  }
  // loose kinds (case / weak_lead / other): infer from the value
  if (URL_RE.test(value)) return "url";
  if (value.includes("@") && value.includes(".")) return "email";
  return "url";
}

// ---- Builder ----------------------------------------------------------------

/** Build canonical, de-duplicated entity nodes from the flat artifact list.
 *  Repeated lookups of the same selector collapse into one node carrying
 *  multiple evidence entries — the structural fix for the duplicate-charge /
 *  re-pivot problem seen in the audited trace. */
export function buildNodes(artifacts: ArtifactInput[]): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const a of artifacts) {
    const rawValue = (a.value ?? "").trim();
    if (!rawValue) continue;
    const type = inferNodeType(a.kind, rawValue);
    const value = normalizeSelector(type, rawValue);
    const id = `${type}:${value}`;
    const sourceClass = classifyArtifact(a);
    const ev: NodeEvidence = {
      source: a.source ?? "unknown",
      sourceClass,
      weight: SOURCE_CLASS_WEIGHT[sourceClass],
      confidence: typeof a.confidence === "number" ? a.confidence : 0,
      timestamp: a.created_at ?? null,
      investigationId: (a.metadata?.investigation_id as string) ?? null,
    };
    const existing = byId.get(id);
    if (existing) {
      existing.evidence.push(ev);
      // merge metadata shallowly; first-seen wins on conflict
      existing.metadata = { ...(a.metadata ?? {}), ...existing.metadata };
    } else {
      byId.set(id, { id, type, value, raw: rawValue, evidence: [ev], metadata: { ...(a.metadata ?? {}) } });
    }
  }
  return [...byId.values()];
}

// ---- Analyzers --------------------------------------------------------------

/** Phase 4 — over-broad / squatted handle. */
export function isGenericHandle(node: GraphNode): boolean {
  if (node.type !== "username" && node.type !== "social_profile") return false;
  const m = node.metadata ?? {};
  const hits =
    (typeof m.platform_hits === "number" && m.platform_hits) ||
    (typeof m.platforms_confirmed === "number" && m.platforms_confirmed) ||
    (Array.isArray(m.sites) ? m.sites.length : 0) ||
    (Array.isArray(m.primary_platforms) ? m.primary_platforms.length : 0) ||
    0;
  if (hits >= GENERIC_HANDLE_MIN_PLATFORMS) return true;
  // obvious dictionary / reuse-prone tokens
  return /^(admin|info|official|contact|support|test|user|sexy|hot|the\w+)/i.test(node.value);
}

/** Phase 5 — node that further lookups should not revisit. */
export function isDeadEnd(node: GraphNode): boolean {
  const m = node.metadata ?? {};
  const status = (typeof m.status === "string" ? m.status : "").toLowerCase();
  if (status === "exhausted" || status === "dead" || status === "not_found") return true;
  if (m.http_status === 404 || m.http_status === 410) return true;
  if (typeof m.dns_result === "string" && /no records/i.test(m.dns_result)) return true;
  if (typeof m.note === "string" && /(expired|defunct|parked|invalid|404)/i.test(m.note)) return true;
  return false;
}

/** Distinct, weight-bearing source classes (excludes the noise classes that
 *  must not count toward corroboration). */
export function distinctSourceClasses(node: GraphNode): SourceClass[] {
  const noise = new Set<SourceClass>(["unknown", "generic", "username_sweep"]);
  const seen = new Set<SourceClass>();
  for (const e of node.evidence) if (!noise.has(e.sourceClass)) seen.add(e.sourceClass);
  return [...seen];
}

export interface ConfidenceGrade {
  score: number;
  status: "verified" | "inferred" | "weak_lead" | "needs_review" | "exhausted";
  distinctClasses: SourceClass[];
  overBroad: boolean;
}

/** Phase 10 — graph confidence model. "verified" requires ≥2 independent
 *  source classes; marketing-leak and generic-handle evidence is hard-capped. */
export function gradeConfidence(node: GraphNode): ConfidenceGrade {
  const distinct = distinctSourceClasses(node);
  const overBroad = isGenericHandle(node);
  const topWeight = node.evidence.reduce((m, e) => Math.max(m, e.weight), 0);

  if (isDeadEnd(node)) {
    return { score: Math.min(topWeight, 30), status: "exhausted", distinctClasses: distinct, overBroad };
  }

  // hard caps
  const onlyMarketing = node.evidence.length > 0 && node.evidence.every((e) => e.sourceClass === "marketing");
  let cap = 100;
  if (overBroad) cap = SOURCE_CLASS_WEIGHT.generic;       // 20
  else if (onlyMarketing) cap = SOURCE_CLASS_WEIGHT.marketing; // 30

  const corroborated = distinct.length >= 2;
  const score = Math.min(topWeight + (corroborated ? 10 : 0), cap);

  let status: ConfidenceGrade["status"];
  if (corroborated && topWeight >= SOURCE_CLASS_WEIGHT.social && !overBroad && !onlyMarketing) status = "verified";
  else if (score >= SOURCE_CLASS_WEIGHT.breach) status = "inferred";
  else if (score >= SOURCE_CLASS_WEIGHT.marketing) status = "weak_lead";
  else status = "needs_review";

  return { score, status, distinctClasses: distinct, overBroad };
}
