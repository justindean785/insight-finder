// lib/tool-cache-version.ts — invalidate a tool's cached results when its INTERPRETATION changes.
//
// tool_call_cache is user-scoped and keyed on sha256({selector_type, selector, tool, params}).
// Nothing in that key says which build produced the row, so a fix to how a tool reads its
// fetches stays invisible until the old rows expire. Measured 2026-09-14: #594 (live build
// 0a04e1b, deployed ~16:30Z) stopped six platforms proving a registration for any handle, and
// a re-scan at 17:19Z still narrated "3 confirmed hits (Mixcloud, Telegram, HackerRank)" —
// `tool_usage_log.cached = true`, replaying a row written at 13:44Z with those sites in
// `found[]`. The fix was correct; the deploy check could not see it.
//
// A tool listed here gets its version folded into both cache hashes, so rows written under
// an older interpretation simply stop matching — they are never read again and age out on
// their TTL. Tools NOT listed keep byte-identical keys: adding this table invalidates nothing
// else. Bump a tool's number in the same PR that changes how that tool decides its result.

import { memoryAuthorityWordingDisabled } from "./memory-provenance.ts";

/** Current result-interpretation version per tool. Absent ⇒ unversioned (legacy key). */
export const TOOL_CACHE_VERSION: Readonly<Record<string, number>> = {
  // v2 — #594: echo-unsafe sites (HackerRank, Mixcloud, Spotify, Telegram, Trakt, NameMC) are
  // `unverified`, never `found`. A v1 row counts them as registrations.
  username_sweep: 2,
  // Deprecated alias that returns the same sweepUsername() result under its own cache key.
  username_search: 2,
  // v2 — the socialfetch host-policy + failure-taxonomy change. Three separate
  // reinterpretations of the SAME (url) key, all of which a v1 row contradicts:
  //   • a skipped host (youtube/roblox/steam/…) is `host_unsupported`, not a read;
  //   • a 2xx under the 200-char floor is `empty_body`, not `ok:true` with `data`;
  //   • a timeout / 5xx / thin body may now answer via the free jina fallback.
  // Without the bump the wrapper serves the pre-fix row before this code runs, so
  // a blank page keeps entering cases as page evidence for the full TTL and the
  // deploy looks like it failed. This is the #599 lesson applied in the same PR
  // that changes the interpretation, which is the only time it is cheap.
  socialfetch_web_read: 2,
  // v2 — lib/negative-lookup.ts. Two reinterpretations of the SAME (ip) / (url) key that a
  // v1 row contradicts: an InternetDB 404 is a proven negative (`ok:true, found:false`), not
  // `{ok:false, status:404}`; and a Jina 200 that wraps an origin error is a negative / a
  // failed read, not `{ok:true, markdown}` page evidence. A v1 jina row would keep replaying
  // an error page as ok for the full 6h TTL, so the verification scan would look like the
  // deploy failed (the #599 lesson, applied in the PR that changes the interpretation).
  shodan_internetdb: 2,
  jina_reader_scrape: 2,
  // v2 — lib/memory-provenance.ts. memory_recall's OUTPUT SHAPE changed: every row carries a
  // `provenance` tag and the payload carries `provenance_legend` + `authority_note` (recalled memory is
  // prior-run context, never evidence). The tool is cacheable (24h, user-scoped) and the key names no
  // build, so a v1 row — untagged rows, no legend, no note — would replay for the full TTL after deploy
  // and bypass the provenance controls the PR exists to add. The bump is the whole fix: v1 rows stop
  // matching on both hashes and age out. (#738 independent review, 2026-10-13.)
  memory_recall: 2,
  // v2 — lib/memory-provenance.ts. minimax_plan_pivots reads the PRIOR MEMORY block (renderPlannerMemoryHint) and
  // appends it to the planner prompt, but the cache key is {seed, already_queried, artifacts, budget_remaining}: the
  // memory block is a second input the key never sees. #738 changes that block from "weight these — … confirmed
  // links" to "CONTEXT TO RE-VERIFY, NOT EVIDENCE", so a plan written under the old wording (its `goal` /
  // `current_findings` may restate a recalled claim as confirmed) would replay for up to 24h after deploy and hand the
  // orchestrator pre-change authority wording. Shape-keyed like memory_recall (see SHAPE_KEYED). (#738 follow-up,
  // owner-authorised 2026-10-13.)
  minimax_plan_pivots: 2,
};

/**
 * KILL SWITCH. `TOOL_CACHE_VERSION_DISABLED=true` restores the unversioned keys, so rows
 * written before this shipped match again. Read at CALL TIME so it takes effect on the
 * running build the moment the secret changes, with no deploy.
 */
export function toolCacheVersioningEnabled(): boolean {
  return (Deno.env.get("TOOL_CACHE_VERSION_DISABLED") ?? "").trim().toLowerCase() !== "true";
}

/**
 * Tools whose cached RESULT is chosen by a RUNTIME switch, not by the build. For these the key must follow the
 * switch state, or a row written in one state is served in the other (see memory_recall_cache_test.ts and
 * minimax_plan_pivots_cache_test.ts).
 *
 * memory_recall: while the provenance wording is ON the result is tagged (v2); while MEMORY_AUTHORITY_WORDING_DISABLED
 * is thrown it is the pre-change legacy shape, so it takes the legacy (unversioned, byte-identical to before) key.
 * Without this, rows written during a rollback were stored under v2 and replayed UNTAGGED for 24h after the switch was
 * flipped back, and tagged rows kept replaying after a rollback (#738 independent review, 2026-10-13).
 *
 * minimax_plan_pivots: the plan is written under whichever PRIOR MEMORY wording was live, so it follows the same
 * switch for the same reason.
 *
 * These tools deliberately ignore TOOL_CACHE_VERSION_DISABLED: that switch means "undo versioning", but for these
 * tools the key is the only thing keeping a pre-change row from being served while the controls are on.
 */
const WORDING_KEYED = (tool: string): (() => number | null) => () =>
  memoryAuthorityWordingDisabled() ? null : (TOOL_CACHE_VERSION[tool] ?? null);
const SHAPE_KEYED: Readonly<Record<string, () => number | null>> = {
  memory_recall: WORDING_KEYED("memory_recall"),
  minimax_plan_pivots: WORDING_KEYED("minimax_plan_pivots"),
};

/** The version to fold into this tool's cache keys, or null for the legacy key. */
export function cacheVersionFor(tool: string): number | null {
  // Own properties only: a tool called "hasOwnProperty" / "toString" / "__proto__" must not resolve to an
  // inherited Object.prototype member (calling it threw; reading it returned a function as the "version").
  const own = (o: object) => Object.prototype.hasOwnProperty.call(o, tool);
  if (own(SHAPE_KEYED)) return SHAPE_KEYED[tool]();
  if (!toolCacheVersioningEnabled()) return null;
  return own(TOOL_CACHE_VERSION) ? (TOOL_CACHE_VERSION[tool] ?? null) : null;
}

/** `/health` → `checks.tool_cache_version`. Presence of the key proves this build is deployed. */
export function describeToolCacheVersions(): { ok: true; detail: string } {
  const wordingOff = memoryAuthorityWordingDisabled();
  const shaped = (tool: string): string => (wordingOff ? `${tool}=legacy-key (wording switch thrown)` : `${tool}=v${TOOL_CACHE_VERSION[tool]}`);
  const shapeKeyed = Object.keys(SHAPE_KEYED);
  if (!toolCacheVersioningEnabled()) {
    return { ok: true, detail: `disabled — TOOL_CACHE_VERSION_DISABLED=true, legacy keys; ${shapeKeyed.map((t) => `${shaped(t)} (keyed by output shape, unaffected)`).join(", ")}` };
  }
  const entries = Object.entries(TOOL_CACHE_VERSION).map(([tool, v]) => (tool in SHAPE_KEYED ? shaped(tool) : `${tool}=v${v}`));
  return { ok: true, detail: entries.length ? entries.join(", ") : "no versioned tools" };
}
