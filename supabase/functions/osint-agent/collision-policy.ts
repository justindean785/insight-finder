// Same-name collision policy (edge runtime).
//
// In the 1677 Iroquois Rd trace the runtime spammed ~10 bare "Wayne Young"
// same-name artifacts and chased a same-surname listing agent ("Karen De
// Young") instead of running scoped public-record pivots. A person-name query
// is only worth running if it is *scoped* by a strong contextual anchor; a bare
// name (or name + a generic platform word / a US state) is broad same-name
// noise that should not run or drive the planner. This module classifies
// person-name QUERIES, flags weak person artifacts (same-surname-only /
// listing-agent leads), and compacts many excluded same-name artifacts into one
// summary so they stop polluting the case.

export type PersonQueryCategory =
  | "broad_same_name"
  | "scoped_person_context"
  | "person_public_record";

export interface PersonQueryDecision {
  category: PersonQueryCategory;
  suppress: boolean;       // true => do not run / do not let it drive the planner
  anchors: string[];       // the contextual anchors found
  reason: string;
}

// People-search / public-record sites. Targeting one (via site: or a bare
// mention) is itself a strong anchor: the lookup is location/name-scoped by the
// site's own index, so these are prioritized rather than suppressed.
const PEOPLE_SEARCH_SITES = [
  "whitepages.com",
  "thatsthem.com",
  "fastpeoplesearch.com",
  "truepeoplesearch.com",
  "radaris.com",
  "beenverified.com",
  "spokeo.com",
];

// US states — a state ALONE is NOT a strong anchor (too broad for a name).
const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "west virginia", "wisconsin", "wyoming",
];

// Generic platform / profile words that are NOT anchors on their own.
const GENERIC_PLATFORM_RE =
  /\b(?:linkedin|facebook|twitter|instagram|tiktok|profile|united\s+states|usa|u\.s\.a?\.?)\b/i;

const PHONE_ANCHOR_RE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const STREET_ANCHOR_RE =
  /\b(?:rd|road|st|street|ave|avenue|blvd|boulevard|dr|drive|ln|lane|ct|court|way|cir|circle|pl|place|ter|terrace|hwy|highway|pkwy|parkway|loop|trail|trl)\b/i;
const COUNTY_ANCHOR_RE = /\b[a-z][a-z'’.-]+\s+county\b/i;
const ORG_ANCHOR_RE =
  /\b(?:inc|incorporated|llc|l\.l\.c|llp|corp|corporation|ltd|limited|company|plc|gmbh|s\.a|nonprofit|foundation|trust|partners|holdings|enterprises|associates)\b/i;
const PARCEL_ANCHOR_RE = /\b(?:apn|parcel)\b/i;
// Public-record / people-search verbs that imply a scoped lookup.
const RECORD_VERB_RE =
  /\b(?:age|address|phone|relatives|property|assessor|recorder)\b/i;
// Known-associate phrasing the model uses when pivoting on a relationship.
const ASSOCIATE_RE =
  /\b(?:associate|known\s+associate|relative|spouse|business\s+partner|co-owner|coworker|colleague)\b/i;

// Quoted spans (e.g. `"Rocklin CA"`) are usually a deliberate scoping anchor.
const QUOTED_RE = /"([^"]+)"/g;

function lower(s: string): string {
  return s.toLowerCase();
}

/** Strip the quoted person-name token(s) so the rest can be scanned for
 * anchors without the name itself counting (e.g. a surname inside the name). */
function withoutPrimaryName(query: string): string {
  // Drop the first quoted span — by convention that's the person name.
  let seen = false;
  return query.replace(QUOTED_RE, (full, inner: string) => {
    if (!seen) {
      seen = true;
      return " ";
    }
    return inner;
  });
}

function peopleSearchSiteIn(query: string): string | null {
  const q = lower(query);
  for (const site of PEOPLE_SEARCH_SITES) {
    if (q.includes(site)) return site;
  }
  return null;
}

// A US city / place token quoted alongside the name (e.g. "Rocklin CA",
// "Rocklin, CA"). We treat a quoted span that isn't a state-only / generic
// token and carries a place shape (word + optional 2-letter state) as a city.
const CITY_IN_QUOTE_RE = /^[a-z][a-z'’.\- ]+(?:,?\s+[a-z]{2})?$/i;

/** Find every strong contextual anchor in a person-name query. */
export function detectQueryAnchors(query: string): string[] {
  const anchors: string[] = [];
  const raw = query ?? "";

  const site = peopleSearchSiteIn(raw);
  if (site) anchors.push(`people-search-site:${site}`);

  // Scan everything except the primary (first quoted) name for anchors.
  const scoped = withoutPrimaryName(raw);
  const scopedLower = lower(scoped);

  if (PHONE_ANCHOR_RE.test(scoped)) anchors.push("phone");
  if (PARCEL_ANCHOR_RE.test(scoped)) anchors.push("parcel");
  if (COUNTY_ANCHOR_RE.test(scoped)) anchors.push("county");
  if (ORG_ANCHOR_RE.test(scoped)) anchors.push("org");
  // Exact street address = a street pattern with a leading number.
  if (STREET_ANCHOR_RE.test(scoped) && /\d/.test(scoped)) {
    anchors.push("address");
  } else if (STREET_ANCHOR_RE.test(scoped)) {
    anchors.push("street");
  }
  if (ASSOCIATE_RE.test(scopedLower)) anchors.push("known_associate");

  // City: a quoted span (other than the name) that names a place and is neither
  // a bare state nor a generic platform word.
  let m: RegExpExecArray | null;
  let quoteIdx = 0;
  QUOTED_RE.lastIndex = 0;
  while ((m = QUOTED_RE.exec(raw)) !== null) {
    quoteIdx += 1;
    if (quoteIdx === 1) continue; // first quote is the name
    const span = m[1].trim();
    const spanLower = lower(span);
    if (!span) continue;
    if (US_STATES.includes(spanLower)) continue;          // state alone: not an anchor
    if (GENERIC_PLATFORM_RE.test(span)) continue;         // platform word: not an anchor
    if (PHONE_ANCHOR_RE.test(span)) continue;             // already counted as phone
    if (STREET_ANCHOR_RE.test(span)) continue;            // already counted as address/street
    if (CITY_IN_QUOTE_RE.test(span) && !ORG_ANCHOR_RE.test(span)) {
      if (!anchors.includes("city")) anchors.push("city");
    }
  }

  // Record verb ("address"/"property"/"assessor"...) only counts as an anchor
  // when a place is also present (a verb + a place = a scoped lookup).
  const hasPlace =
    anchors.includes("city") ||
    anchors.includes("county") ||
    anchors.includes("address") ||
    anchors.includes("street");
  if (RECORD_VERB_RE.test(scopedLower) && hasPlace) {
    anchors.push("record_lookup");
  }

  return anchors;
}

/** Classify a person-name query as worth-running (scoped / public-record) or
 * broad same-name noise that should be suppressed. */
export function classifyPersonQuery(query: string): PersonQueryDecision {
  const anchors = detectQueryAnchors(query);

  // Public-record / people-search site target → prioritize.
  const site = peopleSearchSiteIn(query ?? "");
  if (site) {
    return {
      category: "person_public_record",
      suppress: false,
      anchors,
      reason: `targets public-record site ${site} (strong anchor)`,
    };
  }

  // Any strong contextual anchor → scoped, worth running.
  if (anchors.length > 0) {
    return {
      category: "scoped_person_context",
      suppress: false, // scoped queries are worth running
      anchors,
      reason: `scoped by ${anchors.join(", ")}`,
    };
  }

  // Bare name, or name + only a state / generic platform word → broad noise.
  return {
    category: "broad_same_name",
    suppress: true,
    anchors,
    reason: "bare person name with no strong contextual anchor (broad same-name noise)",
  };
}

// ---- Artifact-level weak-lead suppression -----------------------------------

function metaStrings(meta: Record<string, unknown> | null | undefined): string {
  const m = meta ?? {};
  const parts: string[] = [];
  for (const key of ["note", "notes", "reason", "relationship", "disposition", "role", "title"]) {
    const v = m[key];
    if (typeof v === "string") parts.push(v);
  }
  return parts.join(" — ");
}

// Shared-surname-only / unconfirmed-family phrasing with no corroborating link.
const SAME_SURNAME_RE =
  /\b(?:same\s+surname|shared\s+surname|surname\s+(?:match|only)|potential\s+family|family\s+connection\s+unconfirmed|possible\s+(?:relative|family)|same\s+last\s+name)\b/i;

/** True when a person artifact's note indicates ONLY a shared surname /
 * unconfirmed family tie, with no corroborating overlap. */
export function isSameSurnameOnlyLead(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  const text = metaStrings(meta);
  if (!text) return false;
  return SAME_SURNAME_RE.test(text);
}

// Real-estate listing/selling-agent phrasing. Such a person is a transaction
// contact for the property, NOT a relation of the subject.
const LISTING_AGENT_RE =
  /\b(?:listing\s+agent|selling\s+agent|real\s+estate\s+agent|realtor|re\/?max|listed\s+by|brokerage|coldwell\s+banker|keller\s+williams|century\s+21|sotheby'?s)\b/i;

/** True when role/note marks the person as a real-estate listing/selling agent
 * — a transaction/listing contact, not a subject relation. */
export function isListingAgentLead(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  const text = metaStrings(meta);
  if (!text) return false;
  return LISTING_AGENT_RE.test(text);
}

// ---- Compaction -------------------------------------------------------------

export interface CollisionItem {
  value: string;
  reason?: string;
  source?: string;
}

export interface CollisionSummary {
  kind: "excluded_collision_summary";
  value: string;
  status: "excluded";
  metadata: { items: CollisionItem[]; count: number; note: string };
}

/** Fold many excluded same-name artifacts into one summary so a dozen
 * "Wayne Young" collisions read as a single excluded line, not a dozen leads. */
export function compactCollisions(name: string, items: CollisionItem[]): CollisionSummary {
  const count = items.length;
  return {
    kind: "excluded_collision_summary",
    value: `${count} excluded same-name match${count === 1 ? "" : "es"} for "${name}"`,
    status: "excluded",
    metadata: {
      items,
      count,
      note:
        `Collapsed ${count} broad same-name "${name}" result${count === 1 ? "" : "s"} ` +
        "with no scoping anchor; excluded from the case to avoid same-name noise.",
    },
  };
}
