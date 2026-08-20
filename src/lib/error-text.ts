/**
 * error-text.ts — turn anything thrown into something an analyst can act on.
 *
 * WHY THIS EXISTS. `AnalysisTab` rendered "Could not load analysis: [object
 * Object]" in production. The code looked defensive:
 *
 *     catch (e) { setError(e instanceof Error ? e.message : String(e)); }
 *
 * but the thing being thrown was a Supabase `PostgrestError` — a PLAIN OBJECT
 * (`{ message, details, hint, code }`), not an `Error` instance. So the
 * `instanceof` guard failed, `String(e)` produced "[object Object]", and the one
 * field that would have explained the failure (`message`, plus a `code` like
 * `42501` for RLS or `PGRST116` for a missing relation) was discarded at exactly
 * the moment it was needed.
 *
 * That is worse than no error handling: the screen asserts that something went
 * wrong AND withholds what, so the failure is unreportable and undebuggable
 * from the UI. Every Supabase client method resolves `{ data, error }` with a
 * non-Error error, so the pattern is a trap for anything that rethrows one.
 */

/** Shape of a Supabase/PostgREST error — deliberately structural, not imported,
 *  so this module stays dependency-free and also catches Storage/Auth errors,
 *  which have the same field names but different classes. */
interface PostgrestLike {
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  code?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/**
 * A human-readable, non-empty description of any thrown value.
 *
 * Never returns "[object Object]" and never returns an empty string — a caller
 * rendering "Could not load X: ${describeError(e)}" always produces a sentence
 * with information in it.
 *
 * Supabase errors gain their `code` in parentheses, because the code is what
 * distinguishes the failures an analyst can fix (`42501` — row-level security
 * denied it, i.e. you are signed out or lack access) from the ones they should
 * report (`PGRST116`, `57014` statement timeout).
 */
export function describeError(e: unknown): string {
  if (e == null) return "unknown error";

  if (e instanceof Error && str(e.message)) return str(e.message);

  if (typeof e === "string") return str(e) || "unknown error";

  if (typeof e === "object") {
    const p = e as PostgrestLike;
    const message = str(p.message);
    const code = str(p.code);
    const detail = str(p.details);
    const hint = str(p.hint);
    if (message || code || detail) {
      const head = message || detail || `error ${code}`;
      const parts = [head];
      if (code && message) parts.push(`(${code})`);
      // `hint` is PostgREST's own suggested remedy — the most actionable field
      // it returns, and the one most often dropped on the floor.
      if (hint) parts.push(`— ${hint}`);
      return parts.join(" ");
    }
    // Last resort before "[object Object]": JSON is ugly but it is INFORMATION.
    try {
      const json = JSON.stringify(e);
      if (json && json !== "{}") return json.slice(0, 300);
    } catch { /* circular — fall through */ }
  }

  // `String(e)` is NOT safe on arbitrary input: a null-prototype object
  // (`Object.create(null)`) has no `toString`, and coercing it throws
  // "Cannot convert object to primitive value". An error formatter that can
  // itself throw turns a handled failure into an unhandled one inside the
  // catch block that was supposed to contain it — so the last step is guarded.
  let text: string;
  try {
    text = String(e);
  } catch {
    return "unhandled error (unprintable value)";
  }
  return text === "[object Object]" ? "unknown error" : text;
}

/**
 * Label a failure with WHICH request produced it.
 *
 * `Promise.all` over four queries reports one error with no indication of which
 * of the four failed, which is the difference between "artifacts denied by RLS"
 * and "the evidence log timed out" — two problems with different owners.
 */
export function describeNamedError(name: string, e: unknown): string {
  return `${name}: ${describeError(e)}`;
}
