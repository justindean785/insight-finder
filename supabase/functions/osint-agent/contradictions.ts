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
  /** Stable artifact id. When present, structured patches carry it so the
   *  persistence layer attaches a conflict to the EXACT source artifact rather
   *  than the first row sharing its value (which may live in another cluster). */
  id?: string;
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

// ---------------------------------------------------------------------------
// Name compatibility — before flagging a HIGH "different people" name_conflict
// we normalize and test whether two name strings can describe the SAME person.
// "John Smith" / "John A. Smith" / "Johnny Smith" are compatible variants of one
// identity and must NOT trigger the -25 identity hit; only genuinely
// incompatible names (different surnames, or incompatible given names) do.
// ---------------------------------------------------------------------------

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// Bidirectional nickname <-> formal given-name equivalence groups. Any two names
// in the same group are considered a compatible given-name variance.
const NICKNAME_GROUPS: string[][] = [
  ["john", "johnny", "jon", "jonathan", "jack"],
  ["robert", "rob", "bob", "bobby", "robbie"],
  ["william", "will", "bill", "billy", "willy", "liam"],
  ["michael", "mike", "mikey", "mick"],
  ["james", "jim", "jimmy", "jamie"],
  ["richard", "rick", "rich", "dick", "richie"],
  ["charles", "charlie", "chuck", "chas"],
  ["thomas", "tom", "tommy"],
  ["joseph", "joe", "joey"],
  ["daniel", "dan", "danny"],
  ["david", "dave", "davey"],
  ["christopher", "chris"],
  ["matthew", "matt"],
  ["anthony", "tony"],
  ["andrew", "andy", "drew"],
  ["edward", "ed", "eddie", "ted", "ned"],
  ["kenneth", "ken", "kenny"],
  ["nicholas", "nick", "nicky"],
  ["benjamin", "ben", "benji"],
  ["samuel", "sam", "sammy"],
  ["alexander", "alex", "al", "xander", "sasha"],
  ["nathaniel", "nathan", "nate"],
  ["timothy", "tim", "timmy"],
  ["ronald", "ron", "ronnie"],
  ["donald", "don", "donnie"],
  ["stephen", "steven", "steve", "steph"],
  ["joshua", "josh"],
  ["zachary", "zach", "zack"],
  ["elizabeth", "liz", "beth", "betsy", "eliza", "lizzie"],
  ["katherine", "catherine", "kathryn", "kate", "katie", "kathy", "cathy", "kat"],
  ["margaret", "maggie", "meg", "peggy", "marge"],
  ["jennifer", "jen", "jenny"],
  ["patricia", "pat", "patty", "tricia"],
  ["deborah", "deb", "debbie"],
  ["susan", "sue", "susie"],
  ["jessica", "jess"],
  ["rebecca", "becca", "becky"],
  ["victoria", "vicky", "tori"],
  ["kimberly", "kim"],
];

const NICK_TO_GROUP = new Map<string, number>();
for (let i = 0; i < NICKNAME_GROUPS.length; i++) {
  for (const n of NICKNAME_GROUPS[i]) NICK_TO_GROUP.set(n, i);
}

interface ParsedName {
  given: string;
  middles: string[];
  surname: string; // "" when the name is a single token
}

function parseName(raw: string): ParsedName {
  const cleaned = raw.toLowerCase().replace(/[.,'’]/g, " ").replace(/\s+/g, " ").trim();
  const toks = cleaned.split(" ").filter((t) => t && !NAME_SUFFIXES.has(t));
  if (toks.length === 0) return { given: "", middles: [], surname: "" };
  if (toks.length === 1) return { given: toks[0], middles: [], surname: "" };
  return { given: toks[0], middles: toks.slice(1, -1), surname: toks[toks.length - 1] };
}

/** True when two given names could belong to the same person: identical, a
 *  shared nickname<->formal pair, or one is an initial of the other. */
function givenNamesCompatible(a: string, b: string): boolean {
  if (!a || !b) return true; // a missing given name can't contradict
  if (a === b) return true;
  const ga = NICK_TO_GROUP.get(a);
  const gb = NICK_TO_GROUP.get(b);
  if (ga !== undefined && ga === gb) return true;
  // Initial vs full: "j" vs "john".
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

/** True when two full-name strings can describe the SAME person. Surnames must
 *  match (case/punctuation/suffix-insensitive); given names must be compatible;
 *  middle names/initials are folded (ignored). */
export function namesCompatible(a: string, b: string): boolean {
  const pa = parseName(a);
  const pb = parseName(b);
  // Different surnames → genuinely different people.
  if (pa.surname && pb.surname && pa.surname !== pb.surname) return false;
  return givenNamesCompatible(pa.given, pb.given);
}

// ---------------------------------------------------------------------------
// Location compatibility — before flagging a HIGH location_conflict we fold
// containment / granularity. "Los Angeles" / "CA" / "Los Angeles, CA" all
// describe one place and must NOT trigger the -25 hit; only genuinely
// incompatible locations (different states, or different cities that can't be
// reconciled) do.
// ---------------------------------------------------------------------------

const US_STATES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms", missouri: "mo",
  montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh", "new jersey": "nj",
  "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd", ohio: "oh",
  oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
  "district of columbia": "dc",
};
const STATE_ABBREVS = new Set(Object.values(US_STATES));
const COUNTRY_TOKENS = new Set(["usa", "us", "u s a", "united states", "united states of america", "america"]);

function normState(token: string): string | null {
  const t = token.trim().toLowerCase().replace(/\./g, "");
  if (STATE_ABBREVS.has(t)) return t;
  if (US_STATES[t]) return US_STATES[t];
  return null;
}

interface ParsedLoc {
  city: string | null;
  state: string | null;
  tokens: string[];
}

function parseLoc(raw: string): ParsedLoc {
  const cleaned = raw.toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ").trim();
  let parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  // Drop trailing country tokens ("Los Angeles, CA, USA").
  while (parts.length > 1 && COUNTRY_TOKENS.has(parts[parts.length - 1])) parts.pop();
  const tokens = cleaned.replace(/,/g, " ").split(" ").filter(Boolean);
  if (parts.length === 0) return { city: null, state: null, tokens };
  if (parts.length === 1) {
    const st = normState(parts[0]);
    if (st) return { city: null, state: st, tokens };
    return { city: parts[0], state: null, tokens };
  }
  const last = parts[parts.length - 1];
  const st = normState(last);
  if (st) {
    const city = parts.slice(0, -1).join(" ").trim();
    return { city: city || null, state: st, tokens };
  }
  // No recognizable state → treat first part as city.
  return { city: parts[0], state: null, tokens };
}

function isSubset(a: string[], b: string[]): boolean {
  const setB = new Set(b);
  return a.length > 0 && a.every((t) => setB.has(t));
}

/** True when two location strings can describe the SAME place (containment /
 *  granularity folding). Only genuinely incompatible pairs return false. */
export function locationsCompatible(a: string, b: string): boolean {
  const pa = parseLoc(a);
  const pb = parseLoc(b);
  // Both resolve to a known state and the states differ → genuine conflict.
  if (pa.state && pb.state && pa.state !== pb.state) return false;
  // One string's tokens contain the other's ("Los Angeles" ⊂ "Los Angeles, CA",
  // "CA" ⊂ "Los Angeles, CA") → same place at coarser/finer granularity.
  if (isSubset(pa.tokens, pb.tokens) || isSubset(pb.tokens, pa.tokens)) return true;
  // Same known state → compatible (city-level differences within one state are
  // not treated as a HIGH conflict).
  if (pa.state && pb.state && pa.state === pb.state) return true;
  // Both name a city and the cities differ (no containment, states not proven
  // equal) → different, irreconcilable places.
  if (pa.city && pb.city && pa.city !== pb.city) return false;
  // Otherwise one side is city-only vs state-only (or ambiguous) with no
  // provable conflict → treat as compatible.
  return true;
}

/** True when every distinct value in `values` is pairwise compatible. */
function allMutuallyCompatible(values: string[], compat: (a: string, b: string) => boolean): boolean {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (!compat(values[i], values[j])) return false;
    }
  }
  return true;
}

export function detectContradictions(artifacts: ArtifactLike[]): ContradictionFinding[] {
  const out: ContradictionFinding[] = [];

  // Location conflict — reads the keys the orchestrator actually writes
  // (`based`/`residence`/…), capturing each claim's source so the conflict can
  // be structured rather than buried in prose.
  const locClaims = artifacts
    .map((a) => ({ a, loc: rawMetaStr(a, LOCATION_META_KEYS) }))
    .filter((x): x is { a: ArtifactLike; loc: string } => !!x.loc);
  const distinctLocs = new Set(locClaims.map((x) => x.loc.toLowerCase()));
  const distinctRawLocs = [...new Set(locClaims.map((x) => x.loc))];
  // Only fire HIGH when the distinct locations are GENUINELY incompatible.
  // Containment/granularity variants ("Los Angeles" vs "CA" vs "Los Angeles, CA")
  // fold to one place and must not trigger the -25 identity hit.
  if (distinctLocs.size > 1 && !allMutuallyCompatible(distinctRawLocs, locationsCompatible)) {
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
  const distinctRawNames = [...new Set(names.map((a) => a.value.trim()))];
  // Only fire HIGH when the distinct names are GENUINELY incompatible. Compatible
  // variants of one person ("John Smith" vs "John A. Smith" vs "Johnny Smith")
  // are folded (nicknames, initials, middle names, suffixes, case/punctuation) so
  // they no longer manufacture a bogus "different people" conflict + -25 hit.
  if (distinctNames.size > 1 && !allMutuallyCompatible(distinctRawNames, namesCompatible)) {
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
  /** Artifact value the entry should be attached to (retained for callers that
   *  match by value and for human-readable logging). */
  value: string;
  /** Stable artifact id of the EXACT source artifact, when the input carried
   *  one. Persistence must prefer this over `value`: a value can recur across
   *  clusters, so a value-only match can write a c1 conflict onto a c2 row. */
  id?: string;
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
    // One patch per AFFECTED ARTIFACT (resolved by id from this artifact set),
    // not per value. Emitting by id lets the persistence layer attach the entry
    // to the exact source row; matching only on value can cross-mark a same-value
    // row in a different cluster. When the input carries no ids (pure callers /
    // tests), fall back to a single value-keyed patch per distinct value.
    for (const value of new Set(f.involved)) {
      const matches = artifacts.filter((a) => a.value === value);
      const withIds = matches.filter((a) => typeof a.id === "string" && a.id);
      if (withIds.length > 0) {
        for (const a of withIds) patches.push({ value, id: a.id, entry });
      } else {
        patches.push({ value, entry });
      }
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
