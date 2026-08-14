---
name: The report layer bypasses the integrity engine
description: record_finding derives and persists a correct, independence-capped confidence server-side, but the model retypes the Findings table in prose — so every integrity control lands one layer below what the analyst reads, and four prompt rules were violated by published reports
type: architecture
---
**The finding.** Insight Finder's evidence-integrity controls are real and they work —
at the **write** layer. The **report** layer does not consult them. The model composes
the closing Findings table as prose, so the persisted (correct) numbers never reach the
analyst.

This is the same failure shape as `subject_unlinked` being *"a LABEL, not an
AUTHORITY"*, one layer up. **A prompt rule is not enforcement.**

**Verified on `9fc6ce1`** (`supabase/functions/osint-agent/`). Earlier handoffs cite
line numbers from an older SHA — these were re-measured:

- `tool-registry.ts:5513` — `countIndependentClasses(i.supporting_sources.map(classifySource))`,
  feeding `computeAxes`. The comment above it is **audit F06**: `corroboration_count`
  used to be a raw model-supplied integer, so one `ai_summary`-class source claiming
  `corroboration_count: 5` inflated the artifact axis to 100. Already fixed *at the
  write layer*.
- `system-prompt.ts:135` — `2+ sources = 80+, single source = 40-60, inferred = 20-40`
- `system-prompt.ts:151` — `[CONFIRMED] (≥80)` only on **two independent** sources
- `system-prompt.ts:243` — 2+ **EFFECTIVE** sources; two mirrors of one leak don't clear it
- `system-prompt.ts:245` — run `detect_contradictions`, then **let `record_finding`'s
  server-side confidence stand** rather than asserting a higher number
- `system-prompt.ts:162` — every Findings row must map to an already-persisted artifact;
  "the closing table just renders what is already persisted"

**Evidence.** Two GLM-5.2 runs on the `dosint.info` URL seed (public domain, no PII)
published single-source rows at 95%; run 2 asserted `[CONFIRMED, 2 source classes]` over
two GitHub endpoints, and used **shared Vercel hosting** as a driver for attributing the
domain to a named private individual — which `detectContradictions` exists to flag.

**Fix shape.** Expand a `{{FINDINGS_TABLE}}` marker server-side before the assistant
message is stored, generating the table from persisted rows. No markdown parsing of
model output. **It must never be able to fail finalize.**

**Do NOT.**
- Change `confidence.ts` or `record_finding` — they already compute the right values.
- Gate finalization on evidence completeness, or add work inside the finalize window.
  That path owns this project's worst incidents
  (`INCIDENT_2026-07-26_termination-and-ghost-recovery.md`).

**Owed measurement** (converts the premise from inference to data): pull thread
`3927c644-e9b1-425d-9fab-134e8545eb15`'s artifact rows and diff stored confidence
against the published report table. Not yet done.

**Unblocks** the audit's run-metric idea (`unsupported_statement_count`), which is only
measurable once report claims carry provenance IDs.
