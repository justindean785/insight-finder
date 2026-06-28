// date-sanity.ts — deterministic provenance guard for date-bearing records,
// prioritizing HARM-BEARING kinds (legal/criminal/court/arrest...).
//
// Why this exists: a legal_record was persisted with
//   date_reported: "2026-05-27", created_at: "2026-06-19",
//   note: "Future date detected - possible test/synthetic data"
// That note is objectively false — 2026-05-27 precedes the record's creation.
// The note was authored by the orchestrator LLM, not by code, so the model
// hallucinated a future-date rationale onto a harm-bearing record.
//
// This guard does NOT rely on the model's prose for date classification. It
// compares the record's own date field against the processing date and:
//   • flags genuinely-future dates with a structured warning, and
//   • neutralizes false model-authored "future date" notes when the date is
//     not actually in the future.
//
// It is a sanity/provenance guard ONLY. It NEVER promotes a record, never
// raises confidence, and never changes status. Pure + deterministic (the
// caller supplies `nowIso`) so it is trivially testable.

/** Kinds treated as harm-bearing regardless of value text. */
export const HARM_BEARING_KINDS = new Set([
  "legal_record", "court_record", "arrest_record", "criminal_record", "case",
]);

// Value-text signal for harm-bearing content when the kind itself is generic
// (e.g. an "other"/"event" artifact describing an arrest).
const HARM_BEARING_VALUE_RE =
  /\b(arrest(ed)?|charge[ds]?|indict(ed|ment)?|conviction|convicted|criminal|felony|misdemeanor|warrant|booking|robbery|assault|burglary|homicide|court|docket|case\s*no\.?|bond)\b/i;

// EVENT date keys — the record's OWN event/report date. Only these feed the
// future-suspect check: an event dated after "now" is genuinely anomalous.
const DATE_META_KEYS = [
  "date_reported", "date", "incident_date", "arrest_date", "report_date",
  "charge_date", "filed_date", "offense_date", "booking_date",
];

// SCHEDULING date keys (#9 fix) — forward-looking hearing/trial dates that are
// SUPPOSED to be in the future for an active case. A future court_date must NOT
// flag the whole arrest/legal record as "future date / synthetic". These are
// deliberately excluded from the future-suspect comparison. The earlier guard
// included "court_date" in the event set, so a past arrest with an upcoming
// hearing (e.g. arrest 2026-06-19, court_date 2026-07-06) was wrongly flagged.
const SCHEDULING_DATE_KEYS = new Set([
  "court_date", "hearing_date", "trial_date", "next_court_date", "arraignment_date",
]);

const FUTURE_NOTE_RE = /future[\s-]?date/i;

/** True when a record is harm-bearing by kind or by value text. */
export function isHarmBearing(kind: string, value: string): boolean {
  const k = (kind ?? "").toLowerCase().trim();
  if (HARM_BEARING_KINDS.has(k)) return true;
  return HARM_BEARING_VALUE_RE.test(value ?? "");
}

/** Parse an ISO/date string to a UTC day-number (midnight), or null. Comparing
 *  at day granularity avoids intraday/timezone false positives. */
function toUtcDay(s: string): number | null {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface DateSanityResult {
  /** Fields to merge into the artifact's metadata. Empty when nothing applies. */
  metaPatch: Record<string, unknown>;
  changed: boolean;
}

/**
 * Apply the deterministic date sanity guard.
 *
 * @param kind      artifact kind
 * @param value     artifact value (used for harm-bearing text detection)
 * @param metadata  the artifact's metadata (read-only; not mutated)
 * @param nowIso    the processing reference time (created_at or current time)
 */
export function applyDateSanity(
  kind: string,
  value: string,
  metadata: Record<string, unknown> | null | undefined,
  nowIso: string,
): DateSanityResult {
  const meta = metadata ?? {};
  // Scope: only guard harm-bearing records. Everything else is untouched.
  if (!isHarmBearing(kind, value)) return { metaPatch: {}, changed: false };

  const note = typeof meta.note === "string" ? meta.note : null;
  const hasFutureNote = !!note && FUTURE_NOTE_RE.test(note);

  // Find the first present, parseable date field.
  let dateVal: string | null = null;
  for (const k of DATE_META_KEYS) {
    const raw = meta[k];
    if (typeof raw === "string" && raw.trim() && !Number.isNaN(Date.parse(raw))) {
      dateVal = raw.trim();
      break;
    }
  }

  // No usable EVENT date. Before falling back to "unknown", check whether the
  // only future-dated field is a SCHEDULING date (court/hearing/trial) — those
  // are SUPPOSED to be in the future for an active case, so a model-authored
  // "future date detected" note on such a record is a false positive. (#9: this
  // is the real cause of the "June-19 arrest flagged future" bug — its only
  // forward date was court_date 2026-07-06.)
  if (!dateVal) {
    if (!hasFutureNote) return { metaPatch: {}, changed: false };
    const nowDay0 = toUtcDay(nowIso);
    const hasFutureScheduled = [...SCHEDULING_DATE_KEYS].some((k) => {
      const raw = meta[k];
      if (typeof raw !== "string" || !raw.trim()) return false;
      const d = toUtcDay(raw);
      return d !== null && nowDay0 !== null && d > nowDay0;
    });
    return hasFutureScheduled
      ? {
          metaPatch: {
            date_sanity_status: "ok",
            future_date_detected: false,
            scheduled_future_date: true,
            date_note_corrected: true,
          },
          changed: true,
        }
      : { metaPatch: { date_sanity_status: "unknown" }, changed: true };
  }

  const recDay = toUtcDay(dateVal);
  const nowDay = toUtcDay(nowIso);
  if (recDay === null || nowDay === null) return { metaPatch: {}, changed: false };

  if (recDay > nowDay) {
    // Genuinely future → allow a structured warning. Never promotes.
    return {
      metaPatch: { future_date_detected: true, date_sanity_status: "future_date" },
      changed: true,
    };
  }

  // Date is today or in the past → any "future date" note is objectively false.
  const patch: Record<string, unknown> = {
    future_date_detected: false,
    date_sanity_status: "ok",
  };
  if (hasFutureNote) {
    // Drop only the sentence(s) asserting a future date; preserve the rest and
    // keep the original for provenance.
    const cleaned = note!
      .split(/(?<=[.;])\s+/)
      .filter((s) => !FUTURE_NOTE_RE.test(s))
      .join(" ")
      .trim();
    patch.note = cleaned;
    patch.prior_note = note;
    patch.date_note_corrected = true;
  }
  return { metaPatch: patch, changed: true };
}
