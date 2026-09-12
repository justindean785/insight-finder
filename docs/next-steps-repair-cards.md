# "Suggestion needs repair" crowds the Next-steps rail — an OPEN product call

**Status: open. Not a bug to fix on sight — read this first.**
Raised 2026-09-12 from the `baig_azhar` production case. A previous attempt to
"fix" it silently reversed a documented, e2e-tested invariant; that attempt was
backed out, and this file exists so the next person weighs the same trade
rather than re-deciding it by accident.

## What the analyst sees

On the 2026-09-12 `baig_azhar` case, **three of the four** Next-steps cards read
**"Suggestion needs repair · Review lead"** with no Run button:

| Target rendered on the card | Stated problem |
| --- | --- |
| `the "freelance writer" claim` | target is not a name |
| `Search Memphis-area ICE protest coverage — did Az…` | target is longer than a selector can be; is not a name; is 30 words — a sentence, not a name |
| `Examine the attached image for EXIF data — if the…` | same three |

The one usable card was `Summarize findings`. So the rail — the surface whose
whole job is "what do I do next" — was 75% dead weight.

## Why it happens (mechanism, already measured)

`extractRecommendedPivots` scrapes every line under a `Recommended Next Pivots`
heading. `extractTarget` falls back to **the whole line** when it finds no
identifier in it, and `pivotType` maps anything `detectSeed` cannot classify to
`name`. So a prose recommendation becomes a 30-word `name` pivot.
`pivotSuggestionSchema` then refuses it — correctly — and `PivotPreview` renders
the refusal as a repair card.

Nothing here is malfunctioning. Every component does what it was built to do.
The **composition** produces a bad surface.

## Why the obvious fix is wrong

Dropping malformed lines at the producer looks like a one-line fix. It is not
available, for two reasons:

1. **It reverses a documented invariant.** `pivot-schema.ts`'s docstring states
   it explicitly: *"An invalid suggestion is not deleted — it stays visible as
   'Suggestion needs repair' with the reasons, and it cannot run."*
2. **It contradicts the codebase's central rule.** CLAUDE.md, on quarantined
   artifacts: *"Quarantine is disclosure, not deletion… Any future change that
   makes a quarantined row disappear is a regression, not a tightening."* A
   refused suggestion is the same shape of thing — visible, inert, reasoned.

It is also **pinned by an e2e test** that PR CI does not run:
`e2e/case-integrity.spec.ts` → `next steps › 9 · a malformed generated pivot is
quarantined and cannot run`. The `e2e` job is `if: github.event_name == 'push'`
(a deliberate cost call, see the comment in `.github/workflows/ci.yml`), so a PR
can go green while breaking this. **Run `npm run test:e2e` by hand before
touching this area.** In this sandbox:
`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e`

## The options, with a recommendation

**A — Collapse, don't delete (recommended).** Rank refused suggestions below
runnable ones and fold them into one summary row: *"3 report recommendations
aren't one-click runnable — read them in the report."* Expandable to the current
cards. Keeps every reason on screen, stops the crowding, changes no invariant.
Precedent exists in this repo: the report already collapses 9 same-name
collision artifacts into one grouped row via `groupByReason`.

**B — Distinguish furniture from recommendations.** Drop only report *furniture*
the parser should never have read (Markdown table rows, boilerplate footers,
headings — `BOILERPLATE` already detects these precisely), and keep repair cards
for genuine recommendation lines. Principled, but note it would **not** have
helped the `baig_azhar` case at all: all three dead cards were genuine
recommendation lines. It also weakens the e2e fixture, which is built from a
table row plus a footer.

**C — Render them as prose, not as cards.** A recommendation with no extractable
selector is not a broken suggestion; it is a note. Show it as text under the
rail. Most honest, largest build, and needs a design pass.

**D — Leave it.** Defensible if the view is that a visible refusal is worth its
space. It is the current behaviour.

A and C both need a UI decision, so neither is a drive-by.

## What WAS fixed alongside this (2026-09-12, shipped)

Not blocked on the above, and already in `recommended-pivots.ts`:

- **Kind-led selector extraction.** `Corroborate username jdoe88 across
  platforms` used to yield the target `username jdoe88 across platforms` — not
  runnable, and unmatchable against the tool log's already-searched keys, so the
  card was re-offered on every render however deep the run had gone. The parser
  now reads the token after an explicitly named selector class, accepted only if
  it is well-formed *for that class* (so "Verify email ownership" does not yield
  the selector `ownership`). `name` is excluded so "the name Jordan Vale" is not
  truncated to "Jordan".
- **One shape authority.** `src/lib/pivot-target-shape.ts` now holds the shape
  table that `pivot-schema` validates with and `recommended-pivots` pre-checks
  against, so the producer cannot emit something on a predicate the validator
  disagrees with.
