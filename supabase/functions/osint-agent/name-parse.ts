// name-parse.ts — normalize structured person-name inputs (public-record / broker formats).
//
// Handles "LAST, FIRST MIDDLE" (optionally with trailing US state) so tools like
// indicia_person receive a natural "First … Last" query instead of raw CSV-style text.

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

export interface ParsedStructuredName {
  name: string;
  state?: string;
}

/** Collapse internal whitespace; leave outer trim to callers. */
function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Parse broker / public-record name formats into a search-friendly full name.
 *
 * Examples:
 *   "MORRIS, JARRETT RILEY"       → { name: "JARRETT RILEY MORRIS" }
 *   "MORRIS, JARRETT RILEY, CA"   → { name: "JARRETT RILEY MORRIS", state: "CA" }
 *   "Jane Doe"                    → { name: "Jane Doe" }
 */
export function parseStructuredName(input: string): ParsedStructuredName {
  const raw = normalizeSpaces(input ?? "");
  if (!raw) return { name: "" };

  const commaIdx = raw.indexOf(",");
  if (commaIdx <= 0) return { name: raw };

  const last = normalizeSpaces(raw.slice(0, commaIdx));
  let remainder = normalizeSpaces(raw.slice(commaIdx + 1));
  if (!last || !remainder) return { name: raw };

  let state: string | undefined;

  // Trailing ", ST" or " ST" after the given/first portion.
  const stateSuffix = remainder.match(/^(.+?)(?:,\s*|\s+)([A-Za-z]{2})$/);
  if (stateSuffix) {
    const maybeState = stateSuffix[2].toUpperCase();
    if (US_STATE_CODES.has(maybeState)) {
      remainder = normalizeSpaces(stateSuffix[1]);
      state = maybeState;
    }
  }

  const name = normalizeSpaces(`${remainder} ${last}`);
  return state ? { name, state } : { name };
}
