/**
 * kind-alias — ONE table for "these two kind spellings name the same selector".
 *
 * The auto-persist path writes `ip_address`, `social_account` and
 * `github_account`; the model's record_artifacts path and the dispatch layer
 * speak `ip`, `username`, `domain`, `name`, `wallet`. Until now the alias table
 * lived privately inside `dispatch-rejection.ts`, so aliases were honoured at
 * DISPATCH (a rejected `ip_address` refused `ip` lookups) and nowhere else:
 * the same value persisted twice under two kinds, each twin dedup-keyed
 * separately, and a Dismiss on one twin left the other authoritative in
 * clustering and the report (2026-09-02 production export: `47.…` at 40 AND
 * at 70; two url/social_profile pairs).
 *
 * `canonicalKind` is used in the KIND component of every key that means
 * "this selector": `checkpointKey`, `artifactDedupKey`, `normalizeArtifactKey`
 * and `rejectedTypeAliases`. It never touches the VALUE — that rule is
 * documented on `artifactDedupKey` and stands.
 *
 * Zero imports on purpose: this is a leaf under both the write and read paths.
 */

/** kind spelling → canonical selector type. A kind not listed keys as itself. */
export const KIND_ALIASES: Readonly<Record<string, string>> = {
  handle: "username",
  social: "username",
  social_account: "username",
  github_account: "username",
  subdomain: "domain",
  ip_address: "ip",
  person: "name",
  crypto: "wallet",
  crypto_wallet: "wallet",
};

const URL_SHAPE = /^https?:\/\//i;

/**
 * The canonical kind for a (kind, value) pair. `social_profile` folds onto `url`
 * only when the value is URL-shaped — a `social_profile` row whose value is a
 * bare handle is a username-class observation, not a URL.
 */
export function canonicalKind(kind: unknown, value?: unknown): string {
  const k = String(kind ?? "").trim().toLowerCase();
  if (!k) return "";
  if (k === "social_profile" && URL_SHAPE.test(String(value ?? "").trim())) return "url";
  return KIND_ALIASES[k] ?? k;
}

/** Every spelling under which a selector of this kind must be recognised:
 *  the raw kind plus its canonical form (deduplicated, raw first). */
export function kindAliases(kind: unknown, value?: unknown): string[] {
  const k = String(kind ?? "").trim().toLowerCase();
  if (!k) return [];
  const canonical = canonicalKind(k, value);
  return canonical && canonical !== k ? [k, canonical] : [k];
}
