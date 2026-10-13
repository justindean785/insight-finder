# Evidence-integrity proposals E1–E4 (PROPOSAL ONLY — no code, protected semantics)

Grounded in read-only production SQL (Oct 7–9, 862 artifacts) and code at origin/main 7218401.
Each needs JD sign-off before any code. One edge PR at a time; each PR = behaviour + test + kill switch + new /health key.

## E1 — Breach-PDF rows escape the breach cap (CONFIRMED in data)
Data: thread 7a2968e1. Rows sourced `jina_reader_scrape (FloeIntel breach PDF)` score 75 (emails amr.net, usfca.edu,
calpoly.edu; org rows; the `breach_exposure` row). Breach class cap is 60 (`confidence.ts` CLASS_CAP.breach).
Mechanism: classification keys on the TOOL name (jina = web scrape). The label text ("breach PDF", "user attachment")
and the existing `hasBreachMetadata` laundering guard only fire on metadata KEYS/words in source/note, and the
guard's regex covers breach|leak|darkweb|passwords — "FloeIntel breach PDF" in the SOURCE field of the row is
apparently not reaching it (needs a test to confirm which input the cap engine sees for this call path).
Proposed: when ANY of source label / metadata.source / metadata.sources matches /\bbreach\b.*\b(pdf|file|dump|export|attachment)\b/
OR metadata.user_supplied_origin==='breach_material', add the `breach` class (cap 60). Only ever LOWERS confidence.
Kill switch: BREACH_ORIGIN_CAP_DISABLED. Health key: checks.breach_origin_cap.
Legacy rows: untouched (audit says do not change legacy breach rows); optional reviewed re-cap plan separately.
Risk: low (monotone-lowering). Needs sign-off because it edits confidence caps.

## E2 — "verified @ 90" on pasted docket rows: audit diagnosis is WRONG, real issue is different
Data: two `legal_record` rows, source `user_supplied (unicourt.com docket)`, status verified, conf 90.
Code: `deriveStatus` (confidence.ts:692) DERIVES status server-side; a model-supplied `metadata.status="verified"`
is only a request and is honoured only if there is no open confirmation gap. So "strip model-supplied status" would
change nothing for these rows.
Real question (protected, JD decision): does a user-pasted docket count as a court_record/independent source?
Today it appears to classify via the host in the label (unicourt.com) and reaches the ≥90 path with no reason_not_confirmed.
Options: (a) leave — a pasted docket from the analyst is a high-quality primary doc; (b) classify `user_supplied` as
its own class capped at 75 and status `observed` until an analyst confirms (analyst-only Verified rule preserved);
(c) keep 90 but never set status `verified`/`confirmed` on user_supplied sources (status stays `observed`).
Recommendation: (c) — preserves the score the analyst expects, honours "pasted ≠ checked".
Kill switch USER_SUPPLIED_STATUS_CEILING_DISABLED. Needs sign-off.

## E3 — memory_recall listed as a source (CONFIRMED, 14 rows)
Mechanism: model writes "memory_recall" into row source/sources. Proposed: at write, drop memory_recall (and
memory_*) from source lists and from cluster anchoring; move to metadata.context_from_memory=true. If it was the
ONLY source, cap at ai_summary (55) and status needs_review. Kill switch MEMORY_AS_SOURCE_DISABLED.
Risk: low; lowers or relabels only.

## E4 — password-like metadata keys (CONFIRMED, 21 rows by broad regex) — CONFLICTS WITH A SETTLED DECISION
CLAUDE.md: REVEAL_BREACH_DATA stays ON by design (owner uses raw breach output on own account). Redacting
password fields on write would reverse that. So E4 must NOT ship as "redact on write".
Proposed instead: (a) classify the 21 rows by origin (breach tool output vs model-typed prose);
(b) if JD wants masking, gate on the existing REVEAL_BREACH_DATA flag only (flip = masked-by-default; no per-item
reveal control exists — separate feature); (c) c93b047a handled as a reviewed, reversible, non-deleting plan.
No code until JD confirms intent.

## Not in these proposals
Hygiene dedupe/kind=other (separate small PR), tool-input coercion (extends #698), provider account-state suppression,
P2 timeouts — all evidence-neutral, sequenced after sign-off per queue.
