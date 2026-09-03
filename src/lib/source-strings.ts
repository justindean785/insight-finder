/**
 * source-strings.ts — one coercion for `metadata.sources`, because the column is
 * not the shape the readers assume.
 *
 * ## The crash this exists to stop
 *
 * Every reader of `metadata.sources` was written as
 * `Array.isArray(meta.sources) ? (meta.sources as string[]) : []` — an
 * unchecked cast, in eight places across four files. The source predicates
 * (`isBreachSource` and friends) then call `src.toLowerCase()` on each element.
 *
 * Production carries `breach_exposure` rows written by `breach_check` whose
 * `sources` is an array of OBJECTS, not strings:
 *
 *   [{ "date": "2016-06", "name": "Whitepages.com" }, ...]
 *
 * An object is truthy, so it survives `.filter(Boolean)`, reaches
 * `.toLowerCase()`, and throws `TypeError: e.toLowerCase is not a function`
 * inside a `useMemo` — which the error boundary catches as a blank workspace.
 * The whole case becomes unopenable. Measured 2026-09-03: 2 artifacts across
 * 2 of 216 threads, both from `breach_check`.
 *
 * ## Why non-strings are DROPPED rather than coerced
 *
 * Reading `.name` off those objects would look tidier and would ADD source
 * strings that no row has today — which moves independence counts and therefore
 * confidence. That is an integrity-critical change requiring sign-off, and this
 * is a crash fix. Dropping is behaviour-preserving in the strict sense: a row
 * carrying one of these elements does not currently compute a different answer,
 * it throws, so there is no working behaviour to change.
 *
 * If those corpus names SHOULD count as provenance, that is a deliberate,
 * separate decision — see the handoff.
 */
export function toSourceStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (s) out.push(s);
  }
  return out;
}
