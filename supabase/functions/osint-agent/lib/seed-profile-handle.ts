/**
 * seed-profile-handle — a profile whose URL names the seed handle carries that handle.
 *
 * MEASURED 2026-11-10 with synthetic rows shaped like production. For a username seed, the frontend cluster engine
 * (`buildIdentityClusters`, src/lib/intel.ts) gives a row a `handle:` key from two places only: the value of a
 * `username` row, and `metadata.handle`. A profile row the MODEL records through `record_artifacts` usually carries
 * `platform` and no `handle`, so `x.example/sample.handle` did not join the seed `sample.handle` even though its
 * URL is that handle, while the auto-persisted footprint row (which does carry `handle`) did. The edge engine
 * (lib/cluster.ts) already joins a URL path segment that matches a known handle; the stored row just never said so.
 *
 * This stamps `metadata.handle` on such a row at write time. Operator sign-off: JD, 2026-11-10 (ruling 3A).
 *
 * WHAT IT WILL NOT DO — each line is a namesake hole kept closed:
 *   - never for a shortened or longer handle: the LAST path/query token of the URL must EQUAL the seed handle.
 *     `x.example/sample` is not `sample.handle`, and `x.example/sample.handle2` is not either;
 *   - never from a host label (`sample.tumblr.example`), prose, a display name or a bio;
 *   - never on a row that is excluded, quarantined (`subject_unlinked`) or lifted from a bio (`from_bio`);
 *   - never over a `handle` the row already carries;
 *   - never for a run seeded on anything but a username.
 * A handle match is the cluster engine's weakest identity signal and a handle-only cluster stays capped as a lead;
 * this adds no confidence and changes no cap.
 *
 * Kill switch: SEED_PROFILE_HANDLE_DISABLED=true, read at call time. Zero imports.
 */

export function seedProfileHandleEnabled(): boolean {
  const env = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env;
  return (env?.get("SEED_PROFILE_HANDLE_DISABLED") ?? "").trim().toLowerCase() !== "true";
}

const PROFILE_KINDS = new Set(["social_profile", "profile", "social"]);
const clean = (v: unknown) => String(v ?? "").trim().replace(/^@+/, "").toLowerCase();

/**
 * The handle a profile URL ends in, lowercased, or "" when the value is not a URL with a path.
 * Reads only the URL at the START of the value (model rows often append prose: "x.example/h — display name …").
 * The handle is the last token of the path or query: `/h`, `/user/h`, `/@h`, `/~h`, `?username=h`, `?id=h`.
 */
export function profileUrlHandle(value: string): string {
  const first = String(value ?? "").trim().split(/\s+/)[0] ?? "";
  const noScheme = first.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = noScheme.indexOf("/");
  if (slash <= 0) return "";
  const tokens = noScheme.slice(slash + 1).split(/[/?&=#]+/).filter(Boolean);
  const last = tokens[tokens.length - 1] ?? "";
  let decoded = last;
  try { decoded = decodeURIComponent(last); } catch { /* keep the raw token */ }
  return decoded.replace(/^[@~]+/, "").replace(/[.,;:)]+$/, "").toLowerCase();
}

export const SEED_PROFILE_HANDLE_BASIS = "profile_url_names_seed_handle";

/**
 * The metadata patch for a row being recorded, or null. `seedHandle` is the run's seed when (and only when) it was
 * typed `username`. `meta` is the row's metadata AFTER every exclusion and quarantine stamp has been applied.
 */
export function seedProfileHandlePatch(
  seedHandle: string | null | undefined,
  kind: string,
  value: string,
  meta: Record<string, unknown> | null | undefined,
): { handle: string; handle_basis: string } | null {
  if (!seedHandle || !seedProfileHandleEnabled()) return null;
  const seed = clean(seedHandle);
  if (seed.length < 3) return null;
  if (!PROFILE_KINDS.has(String(kind ?? "").toLowerCase())) return null;
  const m = meta ?? {};
  if (typeof m.handle === "string" && m.handle.trim()) return null;
  if (m.subject_unlinked === true || m.excluded_collision === true || m.from_bio === true || m.bio_cross_link === true) return null;
  if (profileUrlHandle(value) !== seed) return null;
  return { handle: seed, handle_basis: SEED_PROFILE_HANDLE_BASIS };
}

/**
 * /health self-test. Pure. PRESENCE proves the deployed bundle; `switch` reports SEED_PROFILE_HANDLE_DISABLED;
 * ok:false means the predicate failed its own probe.
 */
export function seedProfileHandleSelfTest(): { ok: boolean; enabled: boolean; switch: string; detail: string } {
  const sw = "SEED_PROFILE_HANDLE_DISABLED";
  if (!seedProfileHandleEnabled()) {
    return { ok: true, enabled: false, switch: `${sw}=true`, detail: "LEGACY: a recorded profile row gets no seed handle" };
  }
  const seed = "sample.handle";
  const stamped = (value: string, meta: Record<string, unknown> = {}, kind = "social_profile", s: string | null = seed) =>
    seedProfileHandlePatch(s, kind, value, meta) !== null;
  const wrong: string[] = [];
  if (!stamped("https://x.example/sample.handle")) wrong.push("exact handle not stamped");
  if (!stamped("x.example/@Sample.Handle — display name 'A B'")) wrong.push("@ form with trailing prose not stamped");
  if (!stamped("x.example/user.aspx?username=sample.handle")) wrong.push("query form not stamped");
  if (stamped("https://x.example/sample")) wrong.push("the SHORTENED handle was stamped");
  if (stamped("https://x.example/sample.handle2")) wrong.push("a longer handle was stamped");
  if (stamped("https://sample.handle.x.example")) wrong.push("a host label was stamped");
  if (stamped("sample.handle is on x.example")) wrong.push("prose was stamped");
  if (stamped("https://x.example/sample.handle", { subject_unlinked: true })) wrong.push("a quarantined row was stamped");
  if (stamped("https://x.example/sample.handle", { excluded_collision: true })) wrong.push("an excluded row was stamped");
  if (stamped("https://x.example/sample.handle", { from_bio: true })) wrong.push("a bio link was stamped");
  if (stamped("https://x.example/sample.handle", { handle: "other" })) wrong.push("an existing handle was overwritten");
  if (stamped("https://x.example/sample.handle", {}, "url")) wrong.push("a non-profile kind was stamped");
  if (stamped("https://x.example/sample.handle", {}, "social_profile", null)) wrong.push("a run with no username seed stamped");
  return wrong.length
    ? { ok: false, enabled: true, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      enabled: true,
      switch: `${sw}=false`,
      detail: "a recorded profile row whose URL ends in the exact seed handle gets metadata.handle; shortened, longer, host-label, bio, excluded and quarantined rows do not",
    };
}
