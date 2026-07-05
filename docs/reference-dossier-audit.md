# Reference dossier audit — `craftin247` (accuracy learnings)

A hand-authored "ideal" OSINT dossier for the handle `craftin247` was provided as a
target for report quality. Read as an accuracy exercise, it is a useful **cautionary
example of over-confidence** — the exact failure mode Insight Finder's evidence-integrity
layer is designed to prevent. This note records the weak points and how the app already
guards (or was tightened) against each. It changes **no scoring** — the takeaways are
about presentation honesty and confidence discipline.

## Weak points in the reference, and our guardrail

| # | Reference claim | Weakness | App behavior |
|---|-----------------|----------|--------------|
| 1 | Geographic Location "**Confirmed**" (Washington City, UT) — sourced from "AI-assisted deep search" (conf 55) + "source page review" (65) | AI-summary + single passive read is **not** confirmation | `evidenceStatus`/`bucket` cap AI-summary + single-class evidence to **lead/probable**, never "verified". A model self-labeling "Confirmed" is ignored. |
| 2 | Employment "**Confirmed**" (Dixie Tech) — single "AI-assisted deep search" (conf 45) | Single AI source at 45 stamped Confirmed | Same cap; renders as a lead with an `inferred · unverified` marker. |
| 3 | Steam / Discord IDs "**Confirmed**" via "AI-assisted deep search" | A numeric ID *asserted by an LLM* is fabricable; needs a real platform lookup | Provenance guard flags `provenance_verified === false` / `ai_summary` as inferred; our new Digital Footprint list carries the same `inferred` badge. |
| 4 | Name "Tyler Robinson" (inferred, conf 55) elevated to the headline, **plus** a "news attribution conflict" flag at conf 0 | Newsworthy-namesake / hallucination risk; an AI-inferred name should not headline | Contradiction/namesake signals surface in the **Confidence Verdict** (ADVISORY/BLOCKED) and Accuracy Guardrails; identity clustering keeps unverified names as leads. |
| 5 | "15+ platforms confirmed to be the same individual" from username consistency | **Username reuse ≠ same person** (handles are reused across unrelated people) | Clustering treats a shared handle as a weak single-artifact signal, not a durable identity link (see the Graph tab's explicit "weak single-artifact signal" note). |
| 6 | "Extracted Evidence → Credentials/Passwords: **geanfroy7**" (plaintext) | Credential-masking violation | Policy: credential **presence** is indicated, never the plaintext/hash/hint. Tightened here — the report's "password reuse" note no longer prints values (it was the one place a `password`-kind value could leak). |
| 7 | Timeline entries all "Unknown Date" | No temporal anchoring; reads as filler | Descriptive only; our report keeps capture dates per artifact and does not invent timeline entries. |

## What this drove in the app (display/robustness only)

- **Honesty over emptiness.** A conservative "0 confirmed / N leads" result is *correct*, not broken. The report now says so explicitly (a one-line note under the KPIs) instead of letting the honest, capped result read as a failure — the opposite error from the reference.
- **Completeness.** Surfacing all found evidence (Digital Footprint: handles/accounts/URLs as clickable links, Aliases) makes the report feel complete **without** inflating confidence.
- **Internal consistency.** The two radars no longer share axis names with different math ("Identity"/"Corroboration" → "Identity coverage"/"Cross-source"), so numbers stop contradicting each other.
- **Credential masking** reaffirmed and tightened (item 6).

## Explicitly NOT changed (integrity-locked; needs sign-off)

Confidence caps, source classification, `evidenceStatus`/`bucket` derivation, chain-of-custody,
and minor-safety detection are unchanged. Nothing here promotes a finding to a higher tier. The
lesson from the reference is to be *more* disciplined about confidence, not less.
