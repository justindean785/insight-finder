// Query / entity-type detection (edge runtime — source of truth).
//
// Generalises the failure seen in the 1677 Iroquois Rd trace: the runtime
// treated an address+business case like a generic name search. Routing,
// coverage and exhaustion all key off the query type(s) in play, so detection
// must consider the artifact `kind` and `metadata`, not just a regex on the
// raw value.

export type QueryType =
  | "person"
  | "address"
  | "property"
  | "business"
  | "phone"
  | "email"
  | "username"
  | "domain"
  | "url"
  | "ip"
  | "asn"
  | "image"
  | "media"
  | "crypto_wallet"
  | "transaction"
  | "unknown";

export interface QueryTypeDetection {
  primary: QueryType;
  secondary: QueryType[];
  confidence: number;
  reasons: string[];
}

export interface QueryTypeInput {
  value: string;
  kind?: string | null;
  metadata?: Record<string, unknown> | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const URL_RE = /^https?:\/\//i;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const STREET_RE =
  /\b(?:rd|road|st|street|ave|avenue|blvd|boulevard|dr|drive|ln|lane|ct|court|way|cir|circle|pl|place|ter|terrace|hwy|highway|pkwy|parkway|loop|trail|trl)\b/i;
const BUSINESS_SUFFIX_RE =
  /\b(?:inc|incorporated|llc|l\.l\.c|llp|corp|corporation|ltd|limited|co|company|plc|gmbh|s\.a|nonprofit|foundation|trust|partners|holdings|group|enterprises|associates)\b/i;
const HANDLE_RE = /^@?[a-z0-9._-]{3,32}$/i;
const WALLET_RE = /^(?:0x[a-f0-9]{40}|[13][a-km-zA-HJ-NP-Z0-9]{25,34}|bc1[a-z0-9]{20,80})$/i;
const NAME_RE = /^[A-Z][a-z'’.-]+(?:\s+[A-Z][a-z'’.-]+){1,4}$/;

// Explicit artifact-kind → query type. Authoritative for structured kinds.
const KIND_MAP: Record<string, { primary: QueryType; secondary?: QueryType[] }> = {
  address: { primary: "address", secondary: ["property"] },
  property: { primary: "property", secondary: ["address"] },
  organization: { primary: "business" },
  employer: { primary: "business" },
  company: { primary: "business" },
  business: { primary: "business" },
  phone: { primary: "phone" },
  email: { primary: "email", secondary: ["username", "domain"] },
  username: { primary: "username" },
  social_profile: { primary: "username", secondary: ["person"] },
  social: { primary: "username" },
  domain: { primary: "domain" },
  subdomain: { primary: "domain" },
  url: { primary: "url", secondary: ["domain"] },
  ip: { primary: "ip" },
  crypto_wallet: { primary: "crypto_wallet" },
  person: { primary: "person" },
  name: { primary: "person" },
  alias: { primary: "person" },
  avatar: { primary: "image" },
  image: { primary: "image" },
  media: { primary: "media" },
  media_report: { primary: "media" },
};

function metaHas(meta: Record<string, unknown> | null | undefined, keys: string[]): boolean {
  if (!meta) return false;
  return keys.some((k) => meta[k] !== undefined && meta[k] !== null && meta[k] !== "");
}

/** Detect the query/entity types in play for a seed or artifact. */
export function detectQueryType(input: QueryTypeInput): QueryTypeDetection {
  const value = (input.value ?? "").trim();
  const kind = (input.kind ?? "").toLowerCase().trim();
  const meta = input.metadata ?? null;
  const reasons: string[] = [];
  const secondary = new Set<QueryType>();

  let primary: QueryType = "unknown";
  let confidence = 0;

  // 1) Explicit kind wins for structured kinds.
  const kindMatch = KIND_MAP[kind];
  if (kindMatch) {
    primary = kindMatch.primary;
    confidence = 88;
    reasons.push(`artifact kind '${kind}'`);
    for (const s of kindMatch.secondary ?? []) secondary.add(s);
  }

  // 2) Syntax of the value (only overrides kind when kind was absent/unknown).
  const syntactic = ((): { t: QueryType; c: number; reason: string; sec?: QueryType[] } | null => {
    if (EMAIL_RE.test(value)) return { t: "email", c: 95, reason: "email syntax", sec: ["username", "domain"] };
    if (URL_RE.test(value)) return { t: "url", c: 95, reason: "URL syntax", sec: ["domain"] };
    if (IPV4_RE.test(value)) return { t: "ip", c: 90, reason: "IPv4 syntax" };
    if (WALLET_RE.test(value)) return { t: "crypto_wallet", c: 88, reason: "wallet syntax" };
    if (PHONE_RE.test(value)) return { t: "phone", c: 88, reason: "phone syntax" };
    if (STREET_RE.test(value) && /\d/.test(value)) return { t: "address", c: 85, reason: "street-address pattern", sec: ["property"] };
    if (BUSINESS_SUFFIX_RE.test(value)) return { t: "business", c: 80, reason: "business suffix" };
    if (DOMAIN_RE.test(value) && !value.includes(" ")) return { t: "domain", c: 82, reason: "domain syntax" };
    if (NAME_RE.test(value)) return { t: "person", c: 70, reason: "name-like value" };
    if (HANDLE_RE.test(value) && !value.includes(" ")) return { t: "username", c: 65, reason: "handle-like syntax" };
    return null;
  })();

  if (syntactic) {
    if (!kindMatch) {
      primary = syntactic.t;
      confidence = syntactic.c;
      reasons.push(syntactic.reason);
    } else if (syntactic.t !== primary) {
      // kind already set the primary; record the syntactic type as secondary
      secondary.add(syntactic.t);
      reasons.push(`value also matches ${syntactic.reason}`);
    }
    for (const s of syntactic.sec ?? []) secondary.add(s);
  }

  // 3) Metadata signals add secondary types and confidence.
  if (metaHas(meta, ["beds", "baths", "sqft", "parcel", "apn", "lot_size", "year_built", "last_sold_price", "last_sold_date"])) {
    secondary.add("property");
    if (primary === "address" || primary === "property") confidence = Math.max(confidence, 88);
    reasons.push("property metadata (beds/sqft/parcel)");
  }
  if (metaHas(meta, ["industry", "employees", "founded", "revenue", "ein", "duns", "registered_agent"])) {
    secondary.add("business");
    if (primary === "business") confidence = Math.max(confidence, 85);
    reasons.push("business metadata (industry/employees/founded)");
  }
  if (metaHas(meta, ["platform", "followers", "handle", "bio", "profile_url"])) {
    secondary.add("username");
    reasons.push("social metadata (platform/followers/bio)");
  }
  if (metaHas(meta, ["asn", "ports", "reverse_dns", "rdns", "org"])) {
    secondary.add("ip");
    reasons.push("infrastructure metadata (asn/ports/rdns)");
  }
  if (metaHas(meta, ["associated_business", "business_name", "company_name"])) {
    secondary.add("business");
  }

  if (primary === "unknown") reasons.push("no strong pattern");

  // primary should never also appear in secondary
  secondary.delete(primary);

  return { primary, secondary: [...secondary], confidence, reasons };
}

/** Convenience: the full set of query types (primary + secondary) for routing. */
export function queryTypesOf(input: QueryTypeInput): QueryType[] {
  const d = detectQueryType(input);
  return d.primary === "unknown" ? [...d.secondary] : [d.primary, ...d.secondary];
}
