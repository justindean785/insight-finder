/**
 * Turns an artifact's raw `metadata` blob into labeled, human-readable rows for
 * the Evidence detail panel — replacing the old `JSON.stringify(meta, null, 2)`
 * dump that leaked internal plumbing (cluster_id, cache layers, runtime state)
 * at analysts.
 *
 * PURE + DETERMINISTIC so the hide-list and value formatting are unit-testable.
 * It never mutates the input and never invents data.
 */

/**
 * Keys that are internal plumbing, dev-only, or already surfaced elsewhere in
 * the detail sheet (Source stack / Corroboration / Review / confidence badge).
 * These are hidden from the user-facing rows. Anything prefixed with `_` is also
 * treated as internal by convention.
 */
const HIDDEN_META_KEYS = new Set<string>([
  // handled as badges / dedicated sections
  "false_positive", "collision", "conflict",
  // shown in Source stack / Corroboration already
  "sources", "source", "source_stack", "parent", "parent_source",
  // internal clustering / correlation ids
  "cluster_id", "cluster", "identity_cluster", "correlation_id",
  // cache plumbing
  "cached", "cache_layer", "stale_cache",
  // runtime / orchestration plumbing
  "runtime", "stage", "cycle_id", "selector", "rejection_reason",
  "rejection_source", "expected_value", "ev", "weak_lead", "cost", "charge",
  // storage / vector internals
  "raw", "raw_value", "embedding", "vector",
  // db identifiers
  "thread_id", "investigation_id", "artifact_id", "id", "user_id",
]);

/** Friendly labels for known metadata keys; anything else is Title-cased. */
const META_LABELS: Record<string, string> = {
  source_category: "Source category",
  handle: "Handle",
  username: "Username",
  platform: "Platform",
  url: "Link",
  link: "Link",
  profile_url: "Profile link",
  full_name: "Full name",
  name: "Name",
  location: "Location",
  country: "Country",
  city: "City",
  title: "Title",
  description: "Description",
  summary: "Summary",
  first_seen: "First seen",
  last_seen: "Last seen",
  breach_count: "Breaches",
  breaches: "Breaches",
  domain: "Domain",
  ip: "IP address",
  organization: "Organization",
  org: "Organization",
  registrar: "Registrar",
  created: "Created",
  verified: "Verified",
  reason: "Reason",
  note: "Note",
};

export interface MetaRow {
  key: string;
  label: string;
  value: string;
}

function titleCase(key: string): string {
  const cleaned = key.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return key;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Formats a raw metadata value for display. Returns `null` for values that
 * carry no user-facing signal (empty strings, empty arrays/objects) so the
 * caller can skip the row entirely.
 */
export function formatMetaValue(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t ? t : null;
  }
  if (Array.isArray(raw)) {
    const primitives = raw.filter(
      (v) => v != null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
    );
    if (primitives.length === raw.length && primitives.length > 0) {
      return primitives.map((v) => String(v)).join(", ");
    }
    return raw.length ? `${raw.length} item${raw.length === 1 ? "" : "s"}` : null;
  }
  if (typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>).filter(
      ([, v]) => v != null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
    );
    if (!entries.length) return null;
    return entries.map(([k, v]) => `${titleCase(k)}: ${v}`).join("; ");
  }
  return null;
}

/**
 * Builds the ordered, user-facing metadata rows for an artifact. Hidden/internal
 * keys and empty values are dropped; remaining keys get a friendly label.
 */
export function humanizeArtifactMetadata(
  meta: Record<string, unknown> | null | undefined,
): MetaRow[] {
  if (!meta || typeof meta !== "object") return [];
  const rows: MetaRow[] = [];
  for (const [key, raw] of Object.entries(meta)) {
    if (key.startsWith("_") || HIDDEN_META_KEYS.has(key)) continue;
    const value = formatMetaValue(raw);
    if (value == null || value === "") continue;
    rows.push({ key, label: META_LABELS[key] ?? titleCase(key), value });
  }
  return rows;
}
