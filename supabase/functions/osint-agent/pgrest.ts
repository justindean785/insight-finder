// PostgREST filter-value quoting.
//
// A PostgREST `or=(...)` filter is a comma-separated logic tree, and a
// `cs.{...}` array literal is a comma-separated element list. Interpolating a
// raw value containing a comma therefore splits the tree and the whole query
// fails. Observed live on 2026-07-19 for the seed
// "1677 Iroquois Rd, Rocklin, CA 95765":
//
//   failed to parse logic tree ((subject.eq.1677 iroquois rd, rocklin, ca 95765,
//                                related_values.cs.{1677 iroquois rd, ...}))
//
// The recall sites destructure only `data` (`const { data } = await ...`), so the
// error was discarded and the lookup silently returned zero hits — the agent lost
// all prior-case memory for every comma-bearing selector (i.e. every address)
// with no visible failure.

/** Characters that terminate or structure a PostgREST logic tree or array literal.
 *  A value containing any of these MUST be double-quoted. */
const PGREST_UNSAFE = /[,()"\\{}]/;

/** Quote a value for use inside a PostgREST filter or `cs.{...}` array literal.
 *
 *  Values that contain no structural characters are returned unchanged, so the
 *  wire format for the common seeds (emails, usernames, domains, IPs, phones
 *  without parens) is byte-identical to before — this fix only changes the
 *  queries that were previously malformed. */
export function pgrestQuote(value: string): string {
  const v = String(value ?? "");
  if (!PGREST_UNSAFE.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The `agent_memory` recall filter: match the subject exactly, OR find the
 *  value among an entry's `related_values`. Single source of truth for every
 *  recall site so the quoting can never drift back out of sync. */
export function agentMemoryOrFilter(subject: string): string {
  const q = pgrestQuote(subject);
  return `subject.eq.${q},related_values.cs.{${q}}`;
}
