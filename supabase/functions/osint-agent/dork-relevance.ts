// dork-relevance.ts — reduce dork_harvest false positives (#8).
//
// dork_harvest had a 78-100% false-positive rate: `"<seed>" filetype:pdf`
// matches resume TEMPLATES, court CALENDARS, marriage INDEXES, retirement PDFs
// — any document where the seed appears as example data or a coincidental
// string. Two pure, testable levers here:
//   1. augmentDorkQuery() — append negative keywords that strip template/sample
//      docs at the query level.
//   2. scoreDorkRelevance() — post-harvest, given the fetched document text +
//      the subject's name/city, score 0..1 how likely the hit is really about
//      the subject. Final confidence = cap × relevance, so a template with no
//      name co-occurrence collapses to ~0 and drops out of the findings table.
//
// Pure + deterministic. No confidence/classification logic lives here; callers
// multiply the existing cap by the returned relevance.

const NEGATIVE_KEYWORDS = [
  "sample", "example", "template", "format", "guide", "tutorial", "demo", "placeholder",
];

/** Append negative keyword filters to a Google dork query (idempotent). */
export function augmentDorkQuery(query: string): string {
  const q = (query ?? "").trim();
  if (!q) return q;
  const missing = NEGATIVE_KEYWORDS.filter((k) => !new RegExp(`-["']?${k}\\b`, "i").test(q));
  if (missing.length === 0) return q;
  return `${q} ${missing.map((k) => `-"${k}"`).join(" ")}`;
}

export interface DorkRelevanceInput {
  /** Fetched document text (from jina/scrape). Empty/undefined → treated as not-fetched. */
  text: string | null | undefined;
  /** The dork seed (phone/email/name/etc.) that was searched. */
  seed: string;
  /** Subject's primary name, if known. */
  subjectName?: string;
  /** Subject's city, if known. */
  subjectCity?: string;
  /** The hit URL — used for the .gov/.edu/.org gate. */
  url?: string;
}

export interface DorkRelevance {
  relevance: number; // 0..1
  containsSeed: boolean;
  containsName: boolean;
  containsCity: boolean;
  reason: string;
}

function norm(s: string): string {
  return (s ?? "").toLowerCase();
}

/**
 * Score a dork hit's relevance to the subject.
 *   seed-not-in-text                         → 0    (coincidental / page-number / OCR noise)
 *   .gov/.edu/.org and no subject name       → 0    (template / index / calendar)
 *   seed + name + city                       → 1.0
 *   seed + name                              → 0.85
 *   seed + city (no name)                    → 0.5
 *   seed only                                → 0.2
 *   text not fetched (null)                  → 0.1  (unknown — keep but low)
 */
export function scoreDorkRelevance(input: DorkRelevanceInput): DorkRelevance {
  const text = input.text;
  if (text == null) {
    return { relevance: 0.1, containsSeed: false, containsName: false, containsCity: false, reason: "document text not fetched — relevance unknown" };
  }
  const t = norm(text);
  const seed = norm(input.seed).trim();
  const name = norm(input.subjectName ?? "").trim();
  const city = norm(input.subjectCity ?? "").trim();

  const containsSeed = !!seed && t.includes(seed);
  const containsName = !!name && t.includes(name);
  const containsCity = !!city && t.includes(city);

  let host = "";
  try { host = input.url ? new URL(input.url).hostname.toLowerCase() : ""; } catch { host = ""; }
  const isInstitutional = /\.(gov|edu|org)$/.test(host);

  if (!containsSeed) {
    return { relevance: 0, containsSeed, containsName, containsCity, reason: "seed not present in document text — false positive" };
  }
  if (isInstitutional && !containsName) {
    return { relevance: 0, containsSeed, containsName, containsCity, reason: `${host} document without subject name — likely template/index/calendar` };
  }
  if (containsName && containsCity) {
    return { relevance: 1.0, containsSeed, containsName, containsCity, reason: "seed + subject name + city co-occur" };
  }
  if (containsName) {
    return { relevance: 0.85, containsSeed, containsName, containsCity, reason: "seed + subject name co-occur" };
  }
  if (containsCity) {
    return { relevance: 0.5, containsSeed, containsName, containsCity, reason: "seed + city co-occur (no name)" };
  }
  return { relevance: 0.2, containsSeed, containsName, containsCity, reason: "seed only — no name/city corroboration" };
}

/** Apply relevance to a base confidence cap. Hits below `floor` should be dropped from the main table. */
export function applyDorkRelevance(cap: number, rel: DorkRelevance): number {
  return Math.round((cap ?? 60) * rel.relevance);
}

export const DORK_RELEVANCE_FLOOR = 0.2;
