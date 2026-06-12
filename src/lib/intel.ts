import type { Artifact } from "@/hooks/useThreadArtifacts";
import { detectSeed } from "@/lib/seed";

/** Analyst-grade group buckets for artifact kinds. */
export type Group =
  | "identity"
  | "contact"
  | "social"
  | "infrastructure"
  | "breach"
  | "web"
  | "crypto"
  | "other";

export const GROUP_LABEL: Record<Group, string> = {
  identity: "Identity",
  contact: "Contact",
  social: "Social",
  infrastructure: "Infrastructure",
  breach: "Breach / Exposure",
  web: "Web / Archive",
  crypto: "Crypto",
  other: "Other",
};

export const GROUP_ORDER: Group[] = [
  "identity",
  "contact",
  "social",
  "infrastructure",
  "breach",
  "web",
  "crypto",
  "other",
];

const KIND_TO_GROUP: Record<string, Group> = {
  name: "identity",
  person: "identity",
  avatar: "identity",
  age: "identity",
  dob: "identity",
  gender: "identity",
  email: "contact",
  phone: "contact",
  address: "contact",
  geo: "contact",
  location: "contact",
  username: "social",
  handle: "social",
  social: "social",
  account: "social",
  ip: "infrastructure",
  domain: "infrastructure",
  subdomain: "infrastructure",
  asn: "infrastructure",
  port: "infrastructure",
  host: "infrastructure",
  cert: "infrastructure",
  breach: "breach",
  password: "breach",
  hash: "breach",
  leak: "breach",
  leak_paste: "breach",
  stealer_log: "breach",
  url: "web",
  archive: "web",
  page: "web",
  paste: "web",
  document: "web",
  wallet: "crypto",
  crypto: "crypto",
  tx: "crypto",
};

export function groupForKind(kind: string): Group {
  return KIND_TO_GROUP[kind.toLowerCase()] ?? "other";
}

/** Confidence label used across the analyst surfaces. */
export type ConfLabel =
  | "CONFIRMED"
  | "CORRELATED"
  | "INFERRED"
  | "VERIFY"
  | "CONFLICT"
  | "LOW"
  | "FAILED";

// Sources that are NOT independent corroboration on their own. Breach/leak
// data alone must never produce a CONFIRMED label — it can only support an
// INFERRED or VERIFY claim until a second source class (live profile, web
// page, registry, user-provided context) backs it up.
const BREACH_ONLY_SOURCES = new Set([
  "breach_check",
  "leakcheck_lookup",
  "oathnet_lookup",
  "intelbase_email_lookup",
  "stolen.tax",
  "osintcat",
  "leakcheck",
  "oathnet",
  "intelbase",
  "snusbase",
]);

// Sweep-only sources only prove that a username string is taken on a site —
// they do NOT prove identity ownership. Cap their label at VERIFY when they
// are the sole source class.
const USERNAME_SWEEP_SOURCES = new Set([
  "username_sweep",
  "username_search",
  "stolentax_footprint",
  "deepfind_profile_analyzer",
  "deepfind_reverse_email",
]);

// Direct profile sources observe the value on the actual platform and can
// return rich profile metadata. These are required to upgrade a username or
// social handle to CONFIRMED.
const DIRECT_PROFILE_SOURCES = new Set([
  "socialfetch_lookup",
  "github_user",
  "reddit_user",
  "hackernews_user",
  "gravatar_profile",
  "firecrawl_scrape",
]);

// PII kinds that should never be auto-confirmed from breach data alone.
const SENSITIVE_KINDS = new Set(["dob", "address", "phone", "ssn", "name", "person", "age"]);

export function isBreachSource(src: string | null | undefined, _meta?: Record<string, unknown>): boolean {
  if (!src) return false;
  const s = src.toLowerCase();
  return [...BREACH_ONLY_SOURCES].some((k) => s.includes(k));
}

export function isUsernameSweepSource(src: string | null | undefined, _meta?: Record<string, unknown>): boolean {
  if (!src) return false;
  const s = src.toLowerCase();
  return [...USERNAME_SWEEP_SOURCES].some((k) => s.includes(k));
}

export function isDirectProfileSource(src: string | null | undefined, _meta?: Record<string, unknown>): boolean {
  if (!src) return false;
  const s = src.toLowerCase();
  return [...DIRECT_PROFILE_SOURCES].some((k) => s.includes(k));
}

export function isSensitiveKind(kind: string, meta?: Record<string, unknown>): boolean {
  if (SENSITIVE_KINDS.has(kind.toLowerCase())) return true;
  if (meta && (meta.sensitive === true || meta.pii === true)) return true;
  return false;
}

// Back-compat alias for internal callers.

/**
 * Optional analyst review state (from local review store) that overrides or
 * adjusts the source-derived confidence.
 */
export type ReviewAdjustment =
  | "new"
  | "confirmed"
  | "key"
  | "recheck"
  | "dismissed"
  | "wrong"
  | null
  | undefined;

const REVIEW_DELTA: Record<string, number> = {
  confirmed: 20,
  key: 25,
  recheck: -20,
  wrong: -40,
};

export function adjustedConfidence(a: Artifact, review?: ReviewAdjustment): number {
  const base = a.confidence ?? 0;
  const d = review ? REVIEW_DELTA[review] ?? 0 : 0;
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const metaSources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  const allSources = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  // Corroboration bonus: more distinct source classes = more trustworthy.
  const classes = new Set(
    allSources.map((s) =>
      isBreachSource(s)
        ? "breach"
        : isUsernameSweepSource(s)
        ? "sweep"
        : s.toLowerCase().split(/[_:.]/)[0],
    ),
  );
  let bonus = 0;
  if (classes.size >= 3) bonus += 10;
  else if (classes.size >= 2) bonus += 5;
  // Direct profile observation is the strongest single signal.
  if (allSources.some((s) => isDirectProfileSource(s))) bonus += 5;
  // Breach-only signals get pulled down a hair to fight false certainty.
  if (allSources.length > 0 && allSources.every((s) => isBreachSource(s))) bonus -= 5;
  // Sweep-only handles never imply identity ownership.
  if (allSources.length > 0 && allSources.every((s) => isUsernameSweepSource(s))) bonus -= 10;
  // Explicit conflict / collision metadata is a strong negative signal.
  if (meta.conflict === true || meta.collision === true) bonus -= 15;
  // Possible-minor signal forces a cap so the artifact never auto-promotes.
  if (meta.possible_minor === true) {
    return Math.max(0, Math.min(55, base + d + bonus));
  }
  return Math.max(0, Math.min(100, base + d + bonus));
}

export function labelForArtifact(a: Artifact, review?: ReviewAdjustment): ConfLabel {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  if (review === "dismissed" || review === "wrong" || meta.false_positive === true) return "FAILED";
  if (meta.conflict === true || meta.collision === true) return "CONFLICT";
  // Analyst attestations short-circuit to CONFIRMED.
  if (review === "confirmed" || review === "key" || meta.reviewed === true) return "CONFIRMED";

  const metaSources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  const allSources = [a.source ?? null, ...metaSources].filter(Boolean) as string[];
  const distinctSourceClasses = new Set(
    allSources.map((s) =>
      isBreachSource(s)
        ? "breach"
        : isUsernameSweepSource(s)
        ? "sweep"
        : s.toLowerCase().split(/[_:.]/)[0],
    ),
  );
  const breachOnly =
    allSources.length > 0 && allSources.every((s) => isBreachSource(s));
  const sweepOnly =
    allSources.length > 0 && allSources.every((s) => isUsernameSweepSource(s));
  const hasDirectProfile = allSources.some((s) => isDirectProfileSource(s));
  const sensitive = isSensitiveKind(a.kind, meta);
  const kind = a.kind.toLowerCase();
  const isIdentity = kind === "username" || kind === "handle" || kind === "social" || kind === "name" || kind === "person";
  // Cluster-linkage hint: artifact carries seed-email parent ⇒ it can rise to CORRELATED.
  const parent = String(meta.parent ?? meta.parent_seed ?? meta.seed ?? "").trim().toLowerCase();
  const seedLinked = !!parent && parent.includes("@");

  const c = adjustedConfidence(a, review);

  // Sweep-only handles only prove the username is taken on some site —
  // never identity ownership. Cap at VERIFY.
  if (sweepOnly) {
    return "VERIFY";
  }
  // Breach-only sensitive PII (name/phone/address/DOB/SSN) can never be
  // auto-CONFIRMED. If linked to the seed email it can rise to CORRELATED;
  // otherwise stays at VERIFY.
  if (breachOnly && sensitive) {
    return seedLinked ? "CORRELATED" : "VERIFY";
  }
  // Breach-only non-sensitive data → max INFERRED. Email seen in ≥2 breach
  // sources can rise to CORRELATED (still not CONFIRMED).
  if (breachOnly) {
    if (kind === "email" && allSources.length >= 2) return "CORRELATED";
    return c >= 70 ? "INFERRED" : c >= 40 ? "VERIFY" : "LOW";
  }
  // Username / social handle can only be CONFIRMED when a direct profile
  // source actually observed it on the platform.
  if (isIdentity && !hasDirectProfile) {
    if (c >= 70 && distinctSourceClasses.size >= 2) return "CORRELATED";
    return c >= 50 ? "INFERRED" : "VERIFY";
  }

  // Multi-source-class corroboration → CONFIRMED / CORRELATED.
  if (c >= 85 && distinctSourceClasses.size >= 2) return "CONFIRMED";
  if (c >= 70 && distinctSourceClasses.size >= 2) return "CORRELATED";
  if (c >= 85) return "INFERRED"; // single source class, even if high confidence
  if (c >= 65) return "INFERRED";
  if (c >= 40) return "VERIFY";
  return "LOW";
}

export const CONF_LABEL_HELP: Record<ConfLabel, string> = {
  CONFIRMED: "Supported by ≥2 independent source classes or reviewed by analyst.",
  CORRELATED: "Multiple artifacts point together but no definitive proof.",
  INFERRED: "Source states this but it is not independently corroborated.",
  VERIFY: "Possible match. Needs verification before reporting.",
  CONFLICT: "Conflicts with seed or another identity cluster.",
  LOW: "Low confidence. Treat as a lead, not a finding.",
  FAILED: "Marked as a false positive by the analyst.",
};

export const CONF_LABEL_CLASS: Record<ConfLabel, string> = {
  CONFIRMED: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10",
  CORRELATED: "text-[hsl(var(--confidence-high))]/90 border-[hsl(var(--confidence-high))]/30 bg-[hsl(var(--confidence-high))]/5",
  INFERRED: "text-primary border-primary/40 bg-primary/10",
  VERIFY: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
  CONFLICT: "text-destructive border-destructive/40 bg-destructive/10",
  LOW: "text-muted-foreground border-border bg-secondary/60",
  FAILED: "text-destructive border-destructive/40 bg-destructive/10 line-through",
};

// ---- Pivot inference ---------------------------------------------------

export type PivotType =
  | "email"
  | "username"
  | "domain"
  | "url"
  | "ip"
  | "name"
  | "wallet"
  | "phone";

export type Pivot = {
  value: string;
  type: PivotType;
  why: string;
  source: string;
  sourceArtifactId: string;
  confidence: number;
  fanout: string;
  status: "new" | "searched";
};

const PIVOT_FANOUT: Record<PivotType, string> = {
  email: "Hunter → IntelBase → OathNet → OSINTNova",
  username: "Built-in username sweep → social fetch",
  domain: "crt.sh, Shodan, hackertarget, urlscan",
  url: "urlscan, Wayback, page archive",
  ip: "Shodan, hackertarget, reverse DNS",
  name: "People search, social handle cross-ref",
  wallet: "Chain explorers, sanctions feeds",
  phone: "Carrier lookup, social reverse lookup",
};

const KIND_TO_PIVOT: Record<string, PivotType> = {
  email: "email",
  username: "username",
  handle: "username",
  social: "username",
  domain: "domain",
  subdomain: "domain",
  url: "url",
  ip: "ip",
  name: "name",
  person: "name",
  wallet: "wallet",
  crypto: "wallet",
  phone: "phone",
};

/**
 * Build a deduped pivot queue from current artifacts. A pivot is "searched"
 * when another artifact already references it as a parent/source seed.
 */
export function buildPivots(artifacts: Artifact[], seedValue: string | null): Pivot[] {
  const seedNorm = (seedValue ?? "").trim().toLowerCase();

  // Track which raw values have been used as a parent/source seed by later artifacts.
  const searched = new Set<string>();
  for (const a of artifacts) {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const parent = String(m.parent ?? m.parent_seed ?? m.seed ?? "").trim().toLowerCase();
    if (parent) searched.add(parent);
  }

  const seen = new Map<string, Pivot>();
  for (const a of artifacts) {
    const pType = KIND_TO_PIVOT[a.kind.toLowerCase()];
    if (!pType) continue;
    const v = a.value.trim();
    if (!v) continue;
    const key = `${pType}:${v.toLowerCase()}`;
    if (seen.has(key)) continue;
    if (v.toLowerCase() === seedNorm) continue; // skip the seed itself
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    if (meta.false_positive === true) continue;

    seen.set(key, {
      value: v,
      type: pType,
      why: `${pType[0].toUpperCase() + pType.slice(1)} discovered via ${a.source ?? "tool"}. Expand to find linked accounts.`,
      source: a.source ?? "—",
      sourceArtifactId: a.id,
      confidence: a.confidence ?? 0,
      fanout: PIVOT_FANOUT[pType],
      status: searched.has(v.toLowerCase()) ? "searched" : "new",
    });
  }

  // New pivots first, then by confidence desc.
  return Array.from(seen.values()).sort((a, b) => {
    if (a.status !== b.status) return a.status === "new" ? -1 : 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
}

// ---- Timeline ----------------------------------------------------------

export type TimelineEventType =
  | "seed"
  | "triage"
  | "tool_result"
  | "artifact"
  | "cache_replay"
  | "failed"
  | "report";

export type TimelineItem = {
  id: string;
  time: string;
  type: TimelineEventType;
  title: string;
  source: string | null;
  confidence: number | null;
  kind: string | null;
  explanation: string;
};

/**
 * Build a timeline strictly from artifact rows. Triage / cache / failed
 * events are detected from metadata flags. When `messages` is provided,
 * user queries, tool invocations, and report-generated markers are
 * interleaved with the artifact stream.
 */
export function buildTimelineItems(
  artifacts: Artifact[],
  seed: { value: string | null; type: string | null; createdAt?: string | null } | null,
  messages?: Array<{ id: string; role: string; created_at: string; summary: string; toolCalls: Array<{ toolName: string; resultSummary?: string }> }>,
): TimelineItem[] {
  const items: TimelineItem[] = [];

  // ---- Seed event ----
  if (seed?.value && seed.createdAt) {
    items.push({
      id: "seed",
      time: seed.createdAt,
      type: "seed",
      title: seed.value,
      source: null,
      confidence: null,
      kind: seed.type ?? null,
      explanation: "Investigation seed submitted.",
    });
  }

  // ---- Message-level events ----
  if (messages) {
    for (const msg of messages) {
      // User follow-up queries
      if (msg.role === "user" && msg.summary && msg.summary.length > 0) {
        items.push({
          id: `msg-${msg.id}`,
          time: msg.created_at,
          type: "seed",
          title: msg.summary,
          source: null,
          confidence: null,
          kind: "query",
          explanation: "Follow-up query submitted.",
        });
      }
      // Tool calls
      for (const tc of msg.toolCalls) {
        items.push({
          id: `tc-${msg.id}-${tc.toolName}`,
          time: msg.created_at,
          type: "tool_result",
          title: tc.toolName,
          source: tc.toolName,
          confidence: null,
          kind: "tool_call",
          explanation: tc.resultSummary
            ? `Tool ${tc.resultSummary}.`
            : "Tool invoked.",
        });
      }
      // Report generation markers
      if (msg.role === "assistant" && /report/i.test(msg.summary)) {
        items.push({
          id: `report-${msg.id}`,
          time: msg.created_at,
          type: "report",
          title: "Report generated",
          source: null,
          confidence: null,
          kind: "report",
          explanation: "Final investigation report completed.",
        });
      }
    }
  }

  // ---- Artifact events ----

  for (const a of artifacts) {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const isTriage = a.kind.toLowerCase() === "triage" || meta.triage === true || String(a.source ?? "").toLowerCase().includes("triage");
    const isCache = meta.cached === true || meta._cached === true || meta.cache === true;
    const isFailed = meta.false_positive === true || meta.failed === true || meta.skipped === true;

    let type: TimelineEventType = "artifact";
    let explanation = `Recorded ${a.kind} from ${a.source ?? "unknown source"}.`;
    if (isTriage) {
      type = "triage";
      explanation = "Triage decision recorded.";
    } else if (isFailed) {
      type = "failed";
      explanation = meta.skipped === true
        ? "Source skipped by gate."
        : "Marked as failed / false positive.";
    } else if (isCache) {
      type = "cache_replay";
      explanation = "Result served from cache.";
    }

    items.push({
      id: a.id,
      time: a.created_at,
      type,
      title: a.value,
      source: a.source,
      confidence: a.confidence,
      kind: a.kind,
      explanation,
    });
  }

  items.sort((x, y) => new Date(x.time).getTime() - new Date(y.time).getTime());
  return items;
}

// ---- Tool audit --------------------------------------------------------

export type ToolAuditEntry = {
  tool: string;
  totalResults: number;
  highConf: number;
  lowConf: number;
  cached: number;
  failed: number;
  kinds: string[];
};

export type ToolAudit = {
  tools: ToolAuditEntry[];
  cachedCount: number;
  failedCount: number;
  kindsCovered: Set<string>;
};

export function buildToolAudit(artifacts: Artifact[]): ToolAudit {
  const map = new Map<string, ToolAuditEntry>();
  let cachedCount = 0;
  let failedCount = 0;
  const kindsCovered = new Set<string>();

  for (const a of artifacts) {
    const tool = (a.source ?? "unknown").trim() || "unknown";
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const label = labelForArtifact(a);
    const cached = meta.cached === true || meta._cached === true;
    const failed = label === "FAILED" || meta.skipped === true || meta.failed === true;

    kindsCovered.add(a.kind.toLowerCase());
    if (cached) cachedCount++;
    if (failed) failedCount++;

    const entry = map.get(tool) ?? {
      tool, totalResults: 0, highConf: 0, lowConf: 0, cached: 0, failed: 0, kinds: [],
    };
    entry.totalResults++;
    if (label === "CONFIRMED" || label === "INFERRED") entry.highConf++;
    if (label === "LOW" || label === "VERIFY") entry.lowConf++;
    if (cached) entry.cached++;
    if (failed) entry.failed++;
    if (!entry.kinds.includes(a.kind.toLowerCase())) entry.kinds.push(a.kind.toLowerCase());
    map.set(tool, entry);
  }

  return {
    tools: Array.from(map.values()).sort((a, b) => b.totalResults - a.totalResults),
    cachedCount,
    failedCount,
    kindsCovered,
  };
}

// ---- Source clarity ----------------------------------------------------

export type CacheLayer = "live" | "memory" | "db" | "unknown";

export type ArtifactSourceInfo = {
  primary: string;
  all: string[];
  cacheLayer: CacheLayer;
  parent: string | null;
  rawValue: string | null;
  hasMetadata: boolean;
};

export function extractSourceInfo(a: Artifact): ArtifactSourceInfo {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const metaSources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  const primary = a.source ?? metaSources[0] ?? "unknown";
  const all = Array.from(new Set([...(a.source ? [a.source] : []), ...metaSources])).filter(Boolean);
  let cacheLayer: CacheLayer = "unknown";
  if (meta.cached === true || meta._cached === true) {
    const layer = String(meta._cache_layer ?? meta.cache_layer ?? "").toLowerCase();
    if (layer === "memory" || layer === "mem") cacheLayer = "memory";
    else if (layer === "db" || layer === "database") cacheLayer = "db";
    else cacheLayer = "db";
  } else if (meta.live === true || meta._live === true) {
    cacheLayer = "live";
  } else if (a.source) {
    cacheLayer = "live";
  }
  const parent = (meta.parent ?? meta.parent_seed ?? meta.seed ?? null) as string | null;
  const rawValue = (meta.raw_value ?? meta.raw ?? meta.original ?? null) as string | null;
  const hasMetadata = Object.keys(meta).length > 0;
  return { primary, all, cacheLayer, parent, rawValue, hasMetadata };
}

export const CACHE_LAYER_LABEL: Record<CacheLayer, string> = {
  live: "Live call",
  memory: "Memory cache",
  db: "DB cache",
  unknown: "Unknown",
};

export const CACHE_LAYER_CLASS: Record<CacheLayer, string> = {
  live: "text-primary border-primary/40 bg-primary/10",
  memory: "text-muted-foreground border-border bg-secondary/60",
  db: "text-muted-foreground border-border bg-secondary/60",
  unknown: "text-muted-foreground border-border bg-secondary/40",
};

// ---- Failed / skipped tool extraction ----------------------------------

export type FailedToolEntry = {
  id: string;
  kind: "failed" | "skipped";
  name: string;
  error: string;
  input: unknown;
  output: unknown;
  time: string | null;
  suggestion: string | null;
  messageId: string | null;
  toolCallId: string | null;
};

function suggestFix(name: string, err: string): string | null {
  const e = err.toLowerCase();
  if (e.includes("invalid email") || e.includes("validation")) {
    return "Tool input failed validation. The agent likely passed a non-matching value (e.g. a username into an email field). Use a different tool or pass a `value` field.";
  }
  if (e.includes("rate limit") || e.includes("429")) return "Rate limited. Retry later or use an alternative tool.";
  if (e.includes("401") || e.includes("403") || e.includes("unauthorized")) return "Tool credentials missing or rejected. Check the connector configuration.";
  if (e.includes("timeout")) return "Tool timed out. The remote source may be slow or unreachable.";
  if (e.includes("not found") || e.includes("404")) return "Target was not found by this source.";
  if (name.startsWith("socialfetch") && e.includes("platform")) return "Platform unsupported by socialfetch_lookup. Try http_fingerprint or web search instead.";
  return null;
}

export type RawMessage = {
  id: string;
  role: string;
  parts: unknown;
  created_at: string;
};

/** Subset of an AI SDK tool message part — only the fields read below. */
interface ToolMessagePart {
  type?: string;
  state?: string;
  errorText?: unknown;
  error?: unknown;
  input?: unknown;
  output?: unknown;
  toolCallId?: unknown;
  [k: string]: unknown;
}

export function extractFailedAndSkipped(messages: RawMessage[]): FailedToolEntry[] {
  const out: FailedToolEntry[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const parts = Array.isArray(m.parts) ? (m.parts as ToolMessagePart[]) : [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || typeof p.type !== "string") continue;
      if (!p.type.startsWith("tool-")) continue;
      const name = p.type.replace(/^tool-/, "");
      const failed = p.state === "output-error" || p.errorText != null;
      if (failed) {
        const err = String(p.errorText ?? p.error ?? "Tool failed");
        out.push({
          id: `${m.id}-${i}`,
          kind: "failed",
          name,
          error: err,
          input: p.input,
          output: p.output,
          time: m.created_at ?? null,
          suggestion: suggestFix(name, err),
          messageId: m.id,
          toolCallId: p.toolCallId ?? null,
        });
        continue;
      }
      // list_tools may surface disabled_tools after triage
      if (name === "list_tools" && p.output && typeof p.output === "object") {
        const disabled = (p.output as Record<string, unknown>).disabled_tools;
        if (Array.isArray(disabled)) {
          for (const d of disabled) {
            const tn = String(d?.name ?? "unknown");
            const reason = String(d?.reason ?? "Skipped by triage gate");
            out.push({
              id: `${m.id}-${i}-skip-${tn}`,
              kind: "skipped",
              name: tn,
              error: reason,
              input: null,
              output: null,
              time: m.created_at ?? null,
              suggestion: "Triage gate did not promote this tool. Adjust the seed or run a Stage-1 tool that satisfies the gate.",
              messageId: m.id,
              toolCallId: null,
            });
          }
        }
      }
    }
  }
  return out;
}

// ---- Investigation summary --------------------------------------------

export function buildInvestigationSummary(input: ReportInput): string {
  const { seedValue, seedType, artifacts } = input;
  const audit = buildToolAudit(artifacts);
  const confirmed = artifacts.filter((a) => labelForArtifact(a) === "CONFIRMED").length;
  const verify = artifacts.filter((a) => labelForArtifact(a) === "VERIFY").length;
  const low = artifacts.filter((a) => labelForArtifact(a) === "LOW").length;
  const failed = artifacts.filter((a) => labelForArtifact(a) === "FAILED").length;
  return [
    `Investigation summary`,
    `  Seed: ${seedValue ?? "—"} (${seedType ?? "unknown"})`,
    `  Artifacts: ${artifacts.length} across ${audit.tools.length} tool(s)`,
    `  Confirmed: ${confirmed}  Verify: ${verify}  Low: ${low}  Failed: ${failed}`,
    `  Cached results: ${audit.cachedCount}`,
  ].join("\n");
}

/** Suggested fan-out tool groups based on artifact kinds present. */
export const SUGGESTED_TOOLS_BY_KIND: Record<string, string[]> = {
  email: ["emailrep", "breach_check", "gravatar_profile", "hunter_email_verifier", "intelbase_email_lookup"],
  username: ["username_sweep", "github_user", "reddit_user", "hackernews_user", "google_dorks"],
  domain: ["whois_lookup", "dns_records", "crtsh_subdomains", "hunter_domain_search", "urlscan_search"],
  ip: ["ip_intel", "shodan_internetdb", "hackertarget"],
  url: ["http_fingerprint", "archive_url", "wayback_snapshots", "urlscan_search"],
  crypto: ["crypto_wallet"],
  wallet: ["crypto_wallet"],
};

export function inferToolGaps(audit: ToolAudit): { kind: string; suggested: string[] }[] {
  const used = new Set(
    audit.tools.flatMap((t) => [t.tool.toLowerCase(), ...t.kinds.map((k) => k.toLowerCase())]),
  );
  const gaps: { kind: string; suggested: string[] }[] = [];
  for (const [kind, tools] of Object.entries(SUGGESTED_TOOLS_BY_KIND)) {
    if (!audit.kindsCovered.has(kind)) continue;
    const missing = tools.filter((t) => !used.has(t.toLowerCase()));
    if (missing.length) gaps.push({ kind, suggested: missing });
  }
  return gaps;
}

// ---- Markdown builders -------------------------------------------------

function mdEscape(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

export function buildEvidenceMatrixMarkdown(artifacts: Artifact[]): string {
  if (artifacts.length === 0) return "_No evidence recorded._";
  const rows = artifacts.map((a) => {
    const label = labelForArtifact(a);
    return `| ${mdEscape(a.value)} | ${a.kind} | ${a.source ?? "—"} | ${label} | ${a.confidence ?? "—"} | ${new Date(a.created_at).toISOString()} |`;
  });
  return [
    "| Value | Kind | Source | Label | Confidence | First seen |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export type ReportInput = {
  seedValue: string | null;
  seedType: string | null;
  artifacts: Artifact[];
  messages?: Array<{
    id: string;
    role: "user" | "assistant";
    created_at: string;
    summary: string;
    toolCalls: Array<{ toolName: string; resultSummary?: string }>;
  }>;
};

export function buildReportMarkdown(input: ReportInput): string {
  const { seedValue, seedType, artifacts, messages } = input;
  const total = artifacts.length;

  const confirmed = artifacts.filter((a) => labelForArtifact(a) === "CONFIRMED");
  const inferred = artifacts.filter((a) => labelForArtifact(a) === "INFERRED");
  const verify = artifacts.filter((a) => labelForArtifact(a) === "VERIFY");
  const low = artifacts.filter((a) => labelForArtifact(a) === "LOW");
  const failed = artifacts.filter((a) => labelForArtifact(a) === "FAILED");

  const audit = buildToolAudit(artifacts);
  const gaps = inferToolGaps(audit);
  const clusterReport = buildIdentityClusters(artifacts, seedValue);
  const isNameSearch = !!detectNameLocationSeed(seedValue);

  // Group artifacts for entity table and network connections
  const byGroup = new Map<Group, Artifact[]>();
  for (const a of artifacts) {
    const g = groupForKind(a.kind);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(a);
  }

  const exec = (() => {
    if (total === 0) {
      return `No artifacts have been recorded for this investigation yet. The agent has not produced any observations against the seed.`;
    }
    const parts: string[] = [];
    parts.push(`Observed ${total} artifact${total === 1 ? "" : "s"} across ${audit.tools.length} tool${audit.tools.length === 1 ? "" : "s"}.`);
    if (confirmed.length) parts.push(`${confirmed.length} finding${confirmed.length === 1 ? "" : "s"} observed in multiple sources or analyst-reviewed.`);
    if (verify.length + low.length) parts.push(`${verify.length + low.length} item${verify.length + low.length === 1 ? "" : "s"} need verification before reporting.`);
    if (failed.length) parts.push(`${failed.length} item${failed.length === 1 ? "" : "s"} marked as false positive.`);
    parts.push("All findings are presented as observations from named sources, not as confirmed identity claims.");
    return parts.join(" ");
  })();

  const keyFindings = confirmed.length === 0
    ? "_No high-confidence findings yet._"
    : confirmed.slice(0, 10).map((a) =>
        `- **${a.kind}** — \`${a.value}\` _(source indicates via ${a.source ?? "tool"}, confidence ${a.confidence ?? "—"})_`,
      ).join("\n");

  const entityTable = buildEvidenceMatrixMarkdown(artifacts);

  const network = (() => {
    const sections: string[] = [];
    for (const g of GROUP_ORDER) {
      const items = byGroup.get(g);
      if (!items?.length) continue;
      sections.push(`**${GROUP_LABEL[g]}**\n` + items.map((a) => `- \`${a.value}\` _(observed via ${a.source ?? "tool"})_`).join("\n"));
    }
    return sections.length ? sections.join("\n\n") : "_No correlated entities yet._";
  })();

  const timeline = (() => {
    const items = buildTimelineItems(
      artifacts,
      seedValue ? { value: seedValue, type: seedType, createdAt: null } : null,
      messages,
    );
    if (items.length === 0) return "_No events recorded._";
    return items.slice(-15).map((t) =>
      `- \`${new Date(t.time).toISOString()}\` — **${t.type}** — ${t.title}${t.source ? ` _(via ${t.source})_` : ""}`,
    ).join("\n");
  })();

  const activityLog = (() => {
    if (!messages || messages.length === 0) return "_No message activity recorded._";
    const userQueries = messages.filter((m) => m.role === "user");
    const toolCalls = messages.flatMap((m) => m.toolCalls.map((t) => ({ ...t, at: m.created_at })));
    const reportMarkers = messages.filter((m) => m.role === "assistant" && /report/i.test(m.summary));
    const parts: string[] = [];
    parts.push(`- **User queries:** ${userQueries.length}`);
    parts.push(`- **Tool invocations:** ${toolCalls.length}`);
    if (reportMarkers.length) parts.push(`- **Report markers:** ${reportMarkers.length}`);
    const toolCounts = new Map<string, number>();
    for (const tc of toolCalls) {
      toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) ?? 0) + 1);
    }
    if (toolCounts.size) {
      const breakdown = Array.from(toolCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `\`${name}\`×${n}`)
        .join(", ");
      parts.push(`- **Tool breakdown:** ${breakdown}`);
    }
    const recent = messages
      .filter((m) => m.role === "user" || m.toolCalls.length > 0 || /report/i.test(m.summary))
      .slice(-10);
    if (recent.length) {
      const lines = recent.map((m) => {
        const ts = new Date(m.created_at).toISOString();
        if (m.role === "user") return `- \`${ts}\` — **query** — ${m.summary}`;
        if (m.toolCalls.length) {
          return `- \`${ts}\` — **tools** — ${m.toolCalls.map((t) => `\`${t.toolName}\`${t.resultSummary ? `(${t.resultSummary})` : ""}`).join(", ")}`;
        }
        return `- \`${ts}\` — **report** — ${m.summary}`;
      });
      parts.push("", "**Recent activity:**", ...lines);
    }
    return parts.join("\n");
  })();

  const toolCoverage = audit.tools.length === 0
    ? "_No tools produced artifacts._"
    : audit.tools.map((t) =>
        `- \`${t.tool}\` — ${t.totalResults} result${t.totalResults === 1 ? "" : "s"}, ${t.highConf} high-confidence, ${t.lowConf} need verification${t.cached ? `, ${t.cached} cached` : ""}${t.failed ? `, ${t.failed} failed` : ""}`,
      ).join("\n");

  const weakAreas = (() => {
    const expected: Group[] = ["identity", "contact", "social", "infrastructure"];
    const missing = expected.filter((g) => !byGroup.get(g)?.length);
    const parts: string[] = [];
    if (missing.length) parts.push(`- Missing coverage: ${missing.map((m) => GROUP_LABEL[m]).join(", ")}`);
    if (verify.length) parts.push(`- ${verify.length} item${verify.length === 1 ? "" : "s"} flagged as possible matches that need verification.`);
    if (low.length) parts.push(`- ${low.length} low-confidence lead${low.length === 1 ? "" : "s"} — treat as leads, not findings.`);
    return parts.length ? parts.join("\n") : "_No obvious gaps detected._";
  })();

  const nextSteps = gaps.length === 0
    ? "_No additional tool groups suggested._"
    : gaps.map((g) => `- **${g.kind}** — consider: ${g.suggested.map((t) => `\`${t}\``).join(", ")}`).join("\n");

  const sourceAppendix = audit.tools.length === 0
    ? "_None._"
    : audit.tools.map((t) => `- \`${t.tool}\` — produced ${t.kinds.join(", ") || "—"}`).join("\n");

  return [
    `# OSINT Investigation Report`,
    "",
    ...(clusterReport.warnings.length
      ? [
          `> ⚠️ **${clusterReport.warnings[0]}**`,
          ...clusterReport.warnings.slice(1).map((w) => `> ${w}`),
          "",
        ]
      : []),
    `## Executive Summary`,
    exec,
    "",
    `## Seed Details`,
    `- **Value:** \`${seedValue ?? "—"}\``,
    `- **Type:** ${seedType ?? "unknown"}`,
    ...(clusterReport.seedName ? [`- **Detected subject:** ${clusterReport.seedName}`] : []),
    ...(clusterReport.seedState ? [`- **Detected location target:** ${clusterReport.seedState}`] : []),
    `- **Artifacts recorded:** ${total}`,
    "",
    `## Candidate Identity Clusters`,
    buildClusterSection(clusterReport),
    "",
    `## Key Findings`,
    keyFindings,
    "",
    `## Artifact / Entity Table`,
    entityTable,
    "",
    `## Network Connections`,
    network,
    "",
    ...(isNameSearch
      ? [
          `## What Is Actually Corroborated`,
          clusterReport.clusters.some((c) => c.matchesSeedLocation === true)
            ? clusterReport.clusters
                .filter((c) => c.matchesSeedLocation === true)
                .map((c) => `- ${c.label} — ${c.sources.join(", ") || "single source"}`)
                .join("\n")
            : "_No cluster directly corroborates the seed location yet._",
          "",
          `## What Is Not Corroborated`,
          clusterReport.seedState
            ? `- Direct ${clusterReport.seedState} address/IP evidence for the subject. Out-of-area matches must not be treated as the seed subject without further verification.`
            : "- Subject identity has not been independently corroborated across two source classes.",
          "",
        ]
      : []),
    `## Timeline Summary`,
    timeline,
    "",
    `## Activity Log`,
    activityLog,
    "",
    `## Tool Coverage Summary`,
    toolCoverage,
    "",
    `## Weak Areas`,
    weakAreas,
    "",
    `## Recommended Next Steps`,
    nextSteps,
    "",
    `## Source Appendix`,
    sourceAppendix,
    "",
    `---`,
    `_All items are presented as observations from named sources. Wording such as "observed", "source indicates", "possible match", and "needs verification" is used deliberately. No identity claim should be treated as confirmed without independent corroboration._`,
  ].join("\n");
}

// ---- Identity cluster separation --------------------------------------
//
// Goal: stop merging two same-name people. Group artifacts by hard
// identifiers first (email, phone, username, address, source linkage),
// then split by geographic conflict (different US state / area code /
// IP geo). This is heuristic and CLIENT-SIDE only — no fake data, no
// schema changes.

const US_STATE_TOKENS: Record<string, string> = {
  al: "AL", alabama: "AL", ak: "AK", alaska: "AK",
  az: "AZ", arizona: "AZ", ar: "AR", arkansas: "AR",
  ca: "CA", california: "CA", co: "CO", colorado: "CO",
  ct: "CT", connecticut: "CT", de: "DE", delaware: "DE",
  fl: "FL", florida: "FL", ga: "GA", georgia: "GA",
  hi: "HI", hawaii: "HI", id: "ID", idaho: "ID",
  il: "IL", illinois: "IL", in: "IN", indiana: "IN",
  ia: "IA", iowa: "IA", ks: "KS", kansas: "KS",
  ky: "KY", kentucky: "KY", la: "LA", louisiana: "LA",
  me: "ME", maine: "ME", md: "MD", maryland: "MD",
  ma: "MA", massachusetts: "MA", mi: "MI", michigan: "MI",
  mn: "MN", minnesota: "MN", ms: "MS", mississippi: "MS",
  mo: "MO", missouri: "MO", mt: "MT", montana: "MT",
  ne: "NE", nebraska: "NE", nv: "NV", nevada: "NV",
  nh: "NH", nj: "NJ", nm: "NM", ny: "NY", "new-york": "NY",
  nc: "NC", nd: "ND", oh: "OH", ohio: "OH",
  ok: "OK", oklahoma: "OK", or: "OR", oregon: "OR",
  pa: "PA", pennsylvania: "PA", ri: "RI", sc: "SC", sd: "SD",
  tn: "TN", tennessee: "TN", tx: "TX", texas: "TX",
  ut: "UT", utah: "UT", vt: "VT", va: "VA", virginia: "VA",
  wa: "WA", washington: "WA", wv: "WV", wi: "WI", wisconsin: "WI",
  wy: "WY", dc: "DC",
};

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}

function extractStateFromText(s: string | null | undefined): string | null {
  if (!s) return null;
  for (const tok of tokenize(s)) {
    const st = US_STATE_TOKENS[tok];
    if (st) return st;
  }
  return null;
}

function extractAreaCode(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  // US: optionally leading 1, then 3-digit area code.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

/** Best-effort name + location detection from a free-form seed string. */
export function detectNameLocationSeed(seedValue: string | null): { name: string | null; state: string | null } | null {
  if (!seedValue) return null;
  if (detectSeed(seedValue)?.kind !== "other") return null; // structured seed → not a name search
  const toks = tokenize(seedValue);
  if (toks.length < 2) return null;
  const state = extractStateFromText(seedValue);
  const nameToks = toks.filter((t) => !US_STATE_TOKENS[t]);
  const name = nameToks.length ? nameToks.slice(0, 3).join(" ") : null;
  return { name, state };
}

export type IdentityCluster = {
  id: string;
  label: string;
  artifacts: Artifact[];
  emails: string[];
  usernames: string[];
  phones: string[];
  addresses: string[];
  ips: string[];
  names: string[];
  states: string[];          // observed US state codes
  areaCodes: string[];
  sources: string[];
  confidence: number;        // 0-100, derived from artifact confidences
  warnings: string[];
  matchesSeedLocation: boolean | null;
};

export type ClusterReport = {
  clusters: IdentityCluster[];
  collision: boolean;
  warnings: string[];
  seedName: string | null;
  seedState: string | null;
};

const SHARED_INFRA_NAME_THRESHOLD = 3;
const SHARED_INFRA_KEY_PREFIXES = new Set(["ip", "address", "wallet", "parent"]);

function normalizePersonName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isSharedInfraKey(key: string): boolean {
  return SHARED_INFRA_KEY_PREFIXES.has(key.split(":", 1)[0]);
}

/**
 * Build identity clusters from the artifact set. Conservative union-find:
 * artifacts merge only when they share a STRONG identifier
 * (email / phone / username / address / parent-seed). Then we split any
 * cluster that spans conflicting US states.
 */
export function buildIdentityClusters(
  artifacts: Artifact[],
  seedValue: string | null,
): ClusterReport {
  const seedHint = detectNameLocationSeed(seedValue);
  const seedState = seedHint?.state ?? null;
  const seedName = seedHint?.name ?? null;

  // Map each strong-identifier value → cluster index.
  type Bucket = {
    artifacts: Artifact[];
    keys: Set<string>;
  };
  const buckets: Bucket[] = [];
  const keyToIdx = new Map<string, number>();

  const strongKeysFor = (a: Artifact): string[] => {
    const keys: string[] = [];
    const kind = a.kind.toLowerCase();
    const v = a.value.trim().toLowerCase();
    if (!v) return keys;
    if (["email", "phone", "username", "handle", "address", "ip", "wallet"].includes(kind)) {
      keys.push(`${kind}:${v}`);
    }
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const parent = String(meta.parent ?? meta.parent_seed ?? meta.seed ?? "").trim().toLowerCase();
    if (parent) keys.push(`parent:${parent}`);
    return keys;
  };

  const live = artifacts.filter((a) => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    return m.false_positive !== true;
  });

  // Infrastructure and parent-seed selectors can fan out to unrelated people
  // (shared IPs, households, wallets, breach rows, or collection batches).
  // When one such selector carries three or more distinct names, it is no
  // longer safe to use that selector as an automatic identity-union key.
  const namesByParentKey = new Map<string, Set<string>>();
  for (const a of live) {
    const kind = a.kind.toLowerCase();
    if (kind !== "name" && kind !== "person") continue;
    const name = normalizePersonName(a.value);
    if (!name) continue;
    for (const key of strongKeysFor(a)) {
      if (!key.startsWith("parent:")) continue;
      const names = namesByParentKey.get(key) ?? new Set<string>();
      names.add(name);
      namesByParentKey.set(key, names);
    }
  }

  const namesBySharedKey = new Map<string, Set<string>>();
  for (const [key, names] of namesByParentKey) {
    namesBySharedKey.set(key, new Set(names));
  }
  for (const a of live) {
    const kind = a.kind.toLowerCase();
    if (!SHARED_INFRA_KEY_PREFIXES.has(kind) || kind === "parent") continue;
    const value = a.value.trim().toLowerCase();
    if (!value) continue;
    const selectorKey = `${kind}:${value}`;
    for (const parentKey of strongKeysFor(a).filter((key) => key.startsWith("parent:"))) {
      const linkedNames = namesByParentKey.get(parentKey);
      if (!linkedNames) continue;
      const names = namesBySharedKey.get(selectorKey) ?? new Set<string>();
      linkedNames.forEach((name) => names.add(name));
      namesBySharedKey.set(selectorKey, names);
    }
  }
  const sharedInfraKeys = new Set(
    Array.from(namesBySharedKey.entries())
      .filter(([, names]) => names.size >= SHARED_INFRA_NAME_THRESHOLD)
      .map(([key]) => key),
  );

  for (const a of live) {
    const keys = strongKeysFor(a).filter((key) => !sharedInfraKeys.has(key));
    if (keys.length === 0) {
      buckets.push({ artifacts: [a], keys: new Set() });
      continue;
    }
    const hits = new Set<number>();
    for (const k of keys) {
      const idx = keyToIdx.get(k);
      if (idx !== undefined) hits.add(idx);
    }
    if (hits.size === 0) {
      const idx = buckets.push({ artifacts: [a], keys: new Set(keys) }) - 1;
      for (const k of keys) keyToIdx.set(k, idx);
    } else {
      // Merge into the first hit, union others.
      const indices = Array.from(hits).sort((x, y) => x - y);
      const target = indices[0];
      buckets[target].artifacts.push(a);
      keys.forEach((k) => buckets[target].keys.add(k));
      for (let i = 1; i < indices.length; i++) {
        const src = buckets[indices[i]];
        buckets[target].artifacts.push(...src.artifacts);
        src.keys.forEach((k) => {
          buckets[target].keys.add(k);
          keyToIdx.set(k, target);
        });
        src.artifacts = [];
        src.keys.clear();
      }
      for (const k of buckets[target].keys) keyToIdx.set(k, target);
    }
  }

  // Build descriptive clusters and split by geographic conflict.
  const summarize = (group: Artifact[]): Omit<IdentityCluster, "id" | "label" | "matchesSeedLocation"> => {
    const pick = (kind: string) =>
      Array.from(new Set(group.filter((a) => a.kind.toLowerCase() === kind).map((a) => a.value.trim()))).filter(Boolean);
    const emails = pick("email");
    const usernames = [...pick("username"), ...pick("handle")];
    const phones = pick("phone");
    const addresses = pick("address");
    const ips = pick("ip");
    const names = [...pick("name"), ...pick("person")];
    const states = Array.from(new Set([
      ...addresses.map(extractStateFromText),
      ...group.flatMap((a) => {
        const m = (a.metadata ?? {}) as Record<string, unknown>;
        return [extractStateFromText(String(m.region ?? "")), extractStateFromText(String(m.state ?? "")), extractStateFromText(String(m.geo ?? ""))];
      }),
    ].filter(Boolean))) as string[];
    const areaCodes = Array.from(new Set(phones.map(extractAreaCode).filter(Boolean))) as string[];
    const sources = Array.from(new Set(group.map((a) => a.source ?? "").filter(Boolean)));
    const confidences = group.map((a) => a.confidence ?? 0).filter((n) => n > 0);
    const confidence = confidences.length ? Math.round(confidences.reduce((s, n) => s + n, 0) / confidences.length) : 0;
    return { artifacts: group, emails, usernames, phones, addresses, ips, names, states, areaCodes, sources, confidence, warnings: [] };
  };

  const out: IdentityCluster[] = [];
  let idx = 0;
  for (const b of buckets) {
    if (b.artifacts.length === 0) continue;
    const base = summarize(b.artifacts);
    // Split by US state if a cluster spans more than one observed state.
    if (base.states.length > 1) {
      for (const st of base.states) {
        const subset = b.artifacts.filter((a) => {
          if (extractStateFromText(a.value) === st) return true;
          const m = (a.metadata ?? {}) as Record<string, unknown>;
          return [String(m.region ?? ""), String(m.state ?? ""), String(m.geo ?? "")]
            .some((s) => extractStateFromText(s) === st);
        });
        if (!subset.length) continue;
        const sub = summarize(subset);
        sub.warnings.push(`Split from larger cluster on state=${st}; verify before merging back.`);
        out.push({ ...sub, id: `c${idx}`, label: clusterLabel(idx, sub, seedName), matchesSeedLocation: seedState ? st === seedState : null });
        idx++;
      }
      continue;
    }
    const matches = seedState && base.states[0] ? base.states[0] === seedState : null;
    if (seedState && base.states[0] && base.states[0] !== seedState) {
      base.warnings.push(`Geography conflict: cluster ties to ${base.states[0]} but seed targets ${seedState}.`);
    }
    out.push({ ...base, id: `c${idx}`, label: clusterLabel(idx, base, seedName), matchesSeedLocation: matches });
    idx++;
  }

  // Detect same-name collision across clusters.
  const allNames = out.flatMap((c) => c.names.map((n) => n.toLowerCase()));
  const dupeName = allNames.some((n, i) => allNames.indexOf(n) !== i);
  const conflictingStates = new Set(out.map((c) => c.states[0]).filter(Boolean)).size > 1;
  const conflictingEmailRegions = (() => {
    // emails that don't overlap but clusters claim different states
    const withEmail = out.filter((c) => c.emails.length && c.states.length);
    const states = new Set(withEmail.map((c) => c.states[0]));
    return withEmail.length > 1 && states.size > 1;
  })();
  const conflictingAreaCodes = new Set(out.flatMap((c) => c.areaCodes)).size > 1;
  const collision = dupeName || conflictingStates || conflictingEmailRegions || conflictingAreaCodes;

  const warnings: string[] = [];
  for (const key of sharedInfraKeys) {
    const names = Array.from(namesBySharedKey.get(key) ?? []);
    const kind = key.slice(0, key.indexOf(":"));
    warnings.push(
      `Shared-infrastructure split: one ${kind} selector links ${names.length} distinct names and was excluded from automatic identity merging. Manual corroboration is required.`,
    );
  }
  if (collision) {
    warnings.push(
      "Potential same-name collision detected. The following artifacts may belong to different people and should not be merged without additional corroboration.",
    );
  }
  if (seedState && !out.some((c) => c.matchesSeedLocation)) {
    warnings.push(
      `No direct ${seedState} corroboration found in this run. Out-of-area same-name candidates are shown separately — do not conclude the subject is "not from ${seedState}".`,
    );
  }
  if (conflictingAreaCodes) warnings.push("Phone area codes across clusters disagree — likely different people.");

  // Minor-safety: surface a hard warning if any artifact carries a minor flag.
  const minorArtifacts = artifacts.filter((a) => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    return m.possible_minor === true || m.minor_warning === true;
  });
  if (minorArtifacts.length) {
    warnings.unshift(
      "Possible minor-related signal detected in profile text. Do not expand or expose details without lawful purpose and manual review.",
    );
  }

  // Adult-platform × minor collision: never co-list an adult profile next to a
  // possible-minor artifact in the same primary identity cluster.
  const ADULT_HOSTS = /(onlyfans|fansly|pornhub|manyvids|chaturbate|stripchat|cam4|adultfriendfinder|xhamster|redtube|youporn|spankbang|brazzers)/i;
  const adultArtifacts = artifacts.filter((a) => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const plats = Array.isArray(m.platforms) ? (m.platforms as string[]).join(" ") : "";
    return ADULT_HOSTS.test(a.value) || ADULT_HOSTS.test(plats) || ADULT_HOSTS.test(String(a.source ?? ""));
  });
  if (minorArtifacts.length && adultArtifacts.length) {
    warnings.unshift(
      "SAFETY COLLISION: adult-platform artifacts and possible-minor signals appear in this case. They are NOT confirmed to belong to the same person. Treat as a hard collision warning — manual review required before any further pivoting.",
    );
  }

  // Sort: seed-location matches first, then by confidence.
  out.sort((a, b) => {
    const am = a.matchesSeedLocation === true ? 1 : 0;
    const bm = b.matchesSeedLocation === true ? 1 : 0;
    if (am !== bm) return bm - am;
    return b.confidence - a.confidence;
  });

  return { clusters: out, collision, warnings, seedName, seedState };
}

function clusterLabel(idx: number, c: Omit<IdentityCluster, "id" | "label" | "matchesSeedLocation">, seedName: string | null): string {
  const letter = String.fromCharCode(65 + idx);
  const loc = c.states[0] ?? c.addresses[0] ?? null;
  const who = c.names[0] ?? seedName ?? c.emails[0] ?? c.usernames[0] ?? "unknown";
  return loc ? `Cluster ${letter} — ${who} (${loc})` : `Cluster ${letter} — ${who}`;
}

// ---- Report integration -----------------------------------------------

/** Render an identity-cluster section + collision warning for the markdown report. */
export function buildClusterSection(report: ClusterReport): string {
  if (report.clusters.length === 0) return "_No identity clusters extracted yet._";
  const parts: string[] = [];
  if (report.warnings.length) {
    parts.push(`> ⚠️ **${report.warnings[0]}**`);
    for (const w of report.warnings.slice(1)) parts.push(`> ${w}`);
    parts.push("");
  }
  for (const c of report.clusters) {
    parts.push(`### ${c.label}`);
    parts.push(`- **Confidence:** ${c.confidence}`);
    if (c.matchesSeedLocation === true) parts.push(`- **Seed location match:** yes`);
    else if (c.matchesSeedLocation === false) parts.push(`- **Seed location match:** no — possible different person`);
    if (c.emails.length) parts.push(`- **Emails:** ${c.emails.join(", ")}`);
    if (c.usernames.length) parts.push(`- **Usernames:** ${c.usernames.join(", ")}`);
    if (c.phones.length) parts.push(`- **Phones:** ${c.phones.join(", ")} ${c.areaCodes.length ? `(area ${c.areaCodes.join(", ")})` : ""}`.trim());
    if (c.addresses.length) parts.push(`- **Addresses:** ${c.addresses.join(" • ")}`);
    if (c.states.length) parts.push(`- **States observed:** ${c.states.join(", ")}`);
    if (c.ips.length) parts.push(`- **IPs:** ${c.ips.join(", ")}`);
    if (c.sources.length) parts.push(`- **Source tools:** ${c.sources.join(", ")}`);
    if (c.warnings.length) parts.push(`- **Warnings:** ${c.warnings.join(" / ")}`);
    parts.push("");
  }
  return parts.join("\n");
}
