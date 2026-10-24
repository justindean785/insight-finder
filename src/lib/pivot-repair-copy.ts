// src/lib/pivot-repair-copy.ts — analyst-facing wording for a suggestion that failed validation.
//
// The validator's messages are parser diagnostics ("target is 20 words — a sentence, not a name"). They are
// accurate but read as an error code. The card now leads with one plain sentence and keeps the diagnostics
// one click away. Presentation only: the problems list is unchanged and still decides what may run.

export function describeRepair(problems: string[]): string {
  if (problems.some((p) => /^choose a target/i.test(p))) {
    return "This was read from the report's wording, not confirmed as a handle, and nothing in the case contains it. Nothing was run. If it is a real handle, ask for it in the composer with the handle in quotes (for example: Run a username search on “name”), or record it as evidence first.";
  }
  const sentence = problems.some((p) => /words — a sentence|sentence, not a name/i.test(p));
  if (sentence) {
    return "This suggestion is a sentence, not something that can be searched. Nothing was run. Name the exact email, domain, username or person it refers to, or hide it.";
  }
  if (problems.some((p) => /boilerplate|placeholder/i.test(p))) {
    return "This line from the report is not a search target. Nothing was run.";
  }
  return "The target in this suggestion is not in a form that can be searched. Nothing was run.";
}
