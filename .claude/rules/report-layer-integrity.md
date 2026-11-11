---
paths:
  - "supabase/**"
  - "src/lib/**"
  - "src/components/**"
---

<!-- Loads when editing report/integrity code. Moved verbatim from CLAUDE.md lines 312-356 on 2026-11-10. -->

## ⛔ The report layer bypasses the integrity engine (2026-08-11)

> Every integrity control sits one layer BELOW what the analyst reads.

Same shape as `subject_unlinked` above, one layer up: the capability exists, but nothing
forces the surface to honour it. **A prompt rule is not enforcement.**

`record_finding` already derives the true independence count server-side and persists a
computed, capped confidence — `tool-registry.ts:5513`,
`countIndependentClasses(i.supporting_sources.map(classifySource))`, whose comment is
audit F06 fixing this exact inflation at the write layer. Then the model **retypes the
Findings table in prose**, and the correct numbers never reach the report.

Verified on `9fc6ce1` (line refs re-measured — earlier handoffs cite stale ones):

| Rule | Where | What two GLM-5.2 runs published anyway |
|---|---|---|
| `2+ sources = 80+, single source = 40-60` | `system-prompt.ts:135` | single-source rows at 95% |
| `[CONFIRMED] (≥80)` needs **two independent** sources | `system-prompt.ts:151` | `[CONFIRMED, 2 source classes]` over two GitHub endpoints |
| 2+ **EFFECTIVE** sources; mirrors of one leak don't clear the bar | `system-prompt.ts:243` | same |
| let `record_finding`'s server-side confidence **stand** | `system-prompt.ts:245` | model asserted higher |
| closing table "just renders what is already persisted" | `system-prompt.ts:162` | model retyped it |

`detectContradictions` (`:245`) already flags shared-infra / mirror / same-name
false-links and did **not** stop shared Vercel hosting being used as a driver to
attribute a domain to a named private individual.

**Fix shape** — expand a `{{FINDINGS_TABLE}}` marker server-side before the message is
stored, so the table is generated from persisted rows. No markdown parsing of model
output. **It must never be able to fail finalize.**

**Do NOT:** change `confidence.ts` or `record_finding` (they already compute the right
values); gate finalization on evidence completeness, or add work inside the finalize
window — that path owns this project's worst incidents (see the termination invariants
above).

> **2026-10-24 audit (PR #871) mapped the four counting systems end-to-end.** Two are
> correct (`independentSourceClasses` in `intel.ts`, `computeEffectiveSourceCount` in
> `source-independence.ts`) and two overstate (`tokenizeSourceChain` in `confidence.ts`,
> breach row count in `CaseReport.tsx`). The fix is to wire the per-artifact popover and
> breach summary to the honest systems — a frontend change, not an edge change. The three
> metrics measure genuinely different things (source classes for corroboration, effective
> sources for dedup, distinct breach names for breach corpora); do NOT collapse them into
> one. See `docs/AUDIT_2026-10-24_pivot-workflow-and-language.md` Finding 4.
