# Confidence Engine — Rule Reference & Evidence Weighting

_Status: reference + audit. Produced 2026-07-17 from a line-by-line read of the
live code. Every rule below is cited to `file:line`. This is documentation of
what the engine **does today**, plus a clearly-marked list of integrity findings
that require owner sign-off before code changes (per CLAUDE.md: confidence caps,
ranking, and analyst-confirmation are integrity-critical)._

> ⚠️ **Do not "fix" any number in this document without owner sign-off.** These
> values are the evidence-integrity contract. This doc's job is to make every one
> of them explicit and justified so the arbitrariness the product owner observed
> can be reasoned about — not to unilaterally change ranking.

---

## 0. There are four parallel confidence systems (the root cause of "arbitrary")

The single most important finding: "confidence" is computed and tiered in **four
independent places** that do not share thresholds or increments. The same stored
number therefore renders as different verdicts on different screens.

| # | Module | Role | Authoritative |
|---|--------|------|---------------|
| 1 | `supabase/functions/osint-agent/confidence.ts` (+ `tiers.ts`, `source-classification.ts`, `contradictions.ts`) | Backend cap/axis engine — writes the stored `confidence` | **Yes** (server, chain-of-custody) |
| 2 | `supabase/functions/osint-agent/lib/cluster.ts` | Deterministic cluster promotion + its own tier names | Yes (server, post-cluster) |
| 3 | `src/lib/intel.ts` + `src/lib/review.ts` + `src/lib/confidence.ts` | Frontend re-adjustment, `ConfLabel`, analyst deltas | No (display) — but re-inflates the number |
| 4 | `src/lib/confidence-tier.ts`, `src/lib/audit/confidence-linter.ts` | Two more numeric→tier mappings | No (display / audit) |

**Recommendation (P1):** collapse to one server-authoritative score + one tier
map. Until then, this doc lists all four so the discrepancies are visible.

---

## 1. Tier thresholds (four incompatible taxonomies)

| Taxonomy | confirmed | likely/high | possible/medium | weak/low | unverified | Source |
|---|---|---|---|---|---|---|
| **Display** (badges/bars) | ≥90 | ≥75 | ≥55 | ≥35 | <35 | `confidence-tier.ts:61-65` |
| **Cluster** | ≥90 | ≥75 | ≥50 | ≥30 | <30 | `lib/cluster.ts:26-33` |
| **Audit linter** | 90–100 "Verified" | 71–89 "High" | 41–70 "Medium" | 0–40 "Low" | — | `audit/confidence-linter.ts:11-16` |
| **Backend status** | `confirmed` needs independent≥2 & no contradiction | `verified` (≥90, <2 classes) | `needs_corroboration` | `observed` | — | `confidence.ts:619-624` |

A score of **52** is `Possible` on the cluster map but `weak` on the display map;
**32** is `Weak` on cluster but `unverified` on display. This drift is real
(P2 to reconcile).

---

## 2. How a stored confidence is built (backend, authoritative)

Pipeline: `sourceConfidence()` → `computeAxes()` (5 axes) → `applyEvidenceCaps()`
→ final clamp. All in `confidence.ts` unless noted.

### 2a. Source reliability (the base signal)
| Rule | Condition | Effect | Cite |
|---|---|---|---|
| No-source floor | 0 tools | **30** | `confidence.ts:30` |
| Source reliability | per tool | mean of tier reliabilities | `confidence.ts:31-32` |
| Tier-A reliability | tool ∈ TIER_A | **80** | `tiers.ts:86` |
| Tier-B reliability | tool ∈ TIER_B | **65** | `tiers.ts:87` |
| Tier-C reliability | tool ∈ TIER_C | **40** | `tiers.ts:88` |
| Unknown tier | tool unrecognized | **50** | `tiers.ts:89` |
| Tier-C-only cap | all sources tier C | case ≤ **50** | `tiers.ts:93` |

### 2b. Five-axis engine (`computeAxes`)
| Axis / rule | Effect | Cite |
|---|---|---|
| Corroboration boost | +8 per independent source beyond the 1st, **cap +20** | `confidence.ts:43` |
| Artifact axis | `min(100, src + corroBoost)` | `confidence.ts:44` |
| Contradiction penalty | high +25 / medium +12 / low +5 | `confidence.ts:47-49` |
| Identity axis | `max(0, identityStrength − penalty)` | `confidence.ts:52` |
| Relationship axis | `max(0, relStrength − ⌊penalty/2⌋)` | `confidence.ts:53` |
| Case rollup | `round(min(artifact,rel,identity)·0.7 + src·0.3)` | `confidence.ts:56-57` |

### 2c. Per-source-class ceilings (`CLASS_CAP`, `confidence.ts:73-109`)
The stored score is clamped to the **max cap of the source classes present**.
Selected caps (full table in code):

`breach 60 · threat_intel 50 · username_sweep 45 · social_profile_passive 40 ·
social_profile_active 70 · news 80 · court_record 90 · official_profile_match 85 ·
independent_public 75 · ai_summary 55 · web_search 50 · infra* 65–75 ·
government_property/registry 90 · government_business_license 88 · professional_profile
70 · social_review 35 · public_record 75 · archive 70 · unknown 50`

### 2d. Dynamic cap adjustments (`applyEvidenceCaps`)
| Rule | Effect | Cite |
|---|---|---|
| Two-breach nudge | breach-only & ≥2 breach sources → cap 65 | `confidence.ts:381-383` |
| News-name downgrade | name from `news` → cap 55 (else news 65) | `confidence.ts:372-373` |
| Infra corroboration | ≥2 sub-classes +8, ≥3 +15, `min(95,…)` | `confidence.ts:396-400` |
| Cross-class corroboration | ≥2 corroborating classes (non-infra) +10, `min(95,…)` | `confidence.ts:405-407` |
| Court + news/independent | cap 95 | `confidence.ts:408-410` |
| Cross-platform cluster | ≥3 distinct active-social platforms → `CLUSTER_CAP` **80** | `confidence.ts:179-180, 417-426` |
| NEVER_HIGH ceiling | all classes ∈ NEVER_HIGH → cap `min(cap,65)` | `confidence.ts:153-163, 429-431` |
| No-trusted-non-infra ceiling | no trusted non-infra class → cap `min(cap,85)` | `confidence.ts:439-441` |
| Final clamp | `max(0, min(rawConfidence ?? 50, cap))` | `confidence.ts:443` |

### 2e. Collision / cross-link caps
| Constant | Value | Meaning | Cite |
|---|---|---|---|
| `EXCLUDED_COLLISION_CONFIDENCE` | **15** | model-flagged unrelated/namesake, hard cap | `confidence.ts:494` |
| `BIO_CROSS_LINK_NAME_CAP` | **30** | a name pulled only from another entity's bio | `confidence.ts:521` |
| collision-detector `contradiction` | **40** | same phone/email/address on ≥3 sources or ≥2 clusters | `tool-registry.ts:4455-4492` |

> **On the product owner's "excluded collision → 30":** the true excluded-collision
> cap is **15** (`confidence.ts:494`), not 30. **30** is the _bio-cross-link name_
> cap. The observed 30 is either a bio-linked name, or the frontend re-inflating a
> stored 15 (see §5, F-4). This is a display-vs-store reconciliation item, not a
> constant to change.

---

## 3. The worked examples the owner observed

- **"Single-source email → 50."** 50 is the most overloaded constant in the engine:
  it is simultaneously the unknown-class cap (`CLASS_CAP.unknown`), `web_search`
  cap, the unknown-tier reliability (`tiers.ts:89`), the tier-C-only cap
  (`tiers.ts:93`), and the raw-confidence fallback (`confidence.ts:443`). A lone
  email from a single moderate source lands on one of these 50s. It _looks_
  arbitrary because the value means five different things.
- **"Analyst confirms → 70."** 50 + `REVIEW_DELTA.confirmed (+20)` = 70 (§4).
- **"Address → 70."** There is **no address-specific rule.** 70 is emergent: the
  `social_profile_active` / `infra` / `professional_profile` caps are all 70, so an
  address from any of those classes clamps to 70. Its arbitrariness is that it is
  _un-ruled_ — worth adding an explicit address class + cap (P2).

---

## 4. Analyst confirmation — exactly what "Confirm" does today

Pressing **Confirm** writes `ReviewState="confirmed"` to `artifact_reviews`
(`src/lib/review.ts:219-266`). It does **not** call the backend or change the
stored `confidence`. Its effects are entirely client-side and appear in **three
inconsistent forms**:

1. **Score:** `adjustedConfidence = base + REVIEW_DELTA[review] + bonus`, where
   `REVIEW_DELTA.confirmed = +20`, `key = +25`, `recheck = −20`, clamped to 100
   (`intel.ts:220-259`). This is the number + tier color the Evidence Matrix shows.
2. **Label:** `labelForArtifact` short-circuits to `CONFIRMED` on
   `review==="confirmed" || review==="key" || meta.reviewed===true`
   (`intel.ts:329-330`) — **ahead of the independence checks below it.**
3. **Explanation:** the "why" popover says confirm adds **+15** (`confidence.ts:110`).

**→ The analyst is shown a rationale (+15) that does not equal the applied delta
(+20).** (Finding F-2.)

### Recommended formal model for analyst confirmation (proposal, needs sign-off)
Confirmation should mean **provenance + a bounded lift**, never an unconditional
tier jump:

- **Mark provenance:** record `attested_by`, `attested_at` (already in
  `artifact_reviews`). ✔ keep.
- **Bounded lift, single constant:** one delta (`+20`) used by score, label,
  AND explanation — kill the +15/+20 split.
- **Confirmation raises, but a single source cannot _reach_ Confirmed on
  attestation alone.** Gate the CONFIRMED tier on `independentClasses ≥ 2` at the
  numeric tier **and** the label (today the gate exists only on backend `status`
  and `ConfLabel`, not on the numeric display tier — F-1).
- **Analyst confirmation should set `status = confirmed` server-side** (today the
  backend ignores analyst input entirely — `DeriveStatusInput` has no confirm
  field, `confidence.ts:586-597`), so the durable record matches the screen.

---

## 5. Guardrails — can single-source / AI-inference / cluster-size reach Confirmed?

| Path | Blocked? | Evidence |
|---|---|---|
| **AI inference → Confirmed** | ✅ Blocked | `ai_summary` cap 55, `web_search` cap 50, both ∈ NEVER_HIGH → `min(cap,65)` (`confidence.ts:153-163, 429-431`). Cannot reach 90. |
| **Cluster size → Confirmed** | ✅ Blocked | `CLUSTER_CAP=80` (`confidence.ts:180`); `promoteConfidence` caps co-membership at `min(LIKELY=75, own)` (`lib/cluster.ts:263-270`); only a proven self-admission reaches 90, gated by `isVerifiedSelfAdmission` (`cluster.ts:148-160, 271-276`). Well-tested. |
| **Single source → Confirmed (backend status)** | ✅ Blocked | lone court/gov source has `independentClasses===1` → `deriveStatus` returns `verified`, never `confirmed` (`confidence.ts:619-624`). |
| **Single source → Confirmed (numeric _display_ tier)** | ⚠️ **OPEN** | `CLASS_CAP.court_record=90`, `government_property_record=90`. A single such source stored at 90 → `tierOf(90)==="confirmed"` with the verified glow. **No independence gate exists on the numeric tier** — only on `status`/`ConfLabel`. |
| **`meta.reviewed===true` → CONFIRMED label** | ⚠️ **OPEN / needs owner ruling** | `intel.ts:330` short-circuits to CONFIRMED on model-writable metadata. **A test pins this as intended** (`intel-logic.test.ts:160`), and a comment calls it the "DB-level reviewed upgrade path" (`EvidenceMatrixTab.tsx:54`). If any tool/model can write `metadata.reviewed=true`, this is an AI-inference→Confirmed path (violates Issue #9). **Verify the write path before changing** — it may be human-only, in which case it's fine. |

**Highest-priority integrity items for sign-off:**
- **G1.** Add an `independentClasses ≥ 2` gate to the **numeric** display tier so a
  lone 90-capped court/gov source shows ≤ "Likely", matching backend `status`.
- **G2.** Confirm whether `metadata.reviewed` is human-only. If a tool/model can
  set it, gate the CONFIRMED short-circuit on a real `artifact_reviews` row.

---

## 6. Arbitrary-increment inventory (each needs a documented rationale or removal)

1. Corroboration curve exists in **three** unreconciled forms: backend +8/cap20
   (`confidence.ts:43`), frontend +6/cap18 (`src/lib/confidence.ts:85-86`),
   step +5/+10 (`intel.ts:244-245`).
2. Analyst deltas exist in **two** forms: +20/+25/−20 (`intel.ts:220-223`,
   `review.ts:62-69`) vs +15/+18/−12 (`confidence.ts:110-114`).
3. Recency curve exists in **two** forms: +4/−4/−10 (`src/lib/confidence.ts:99-105`)
   vs the radar step 100/85/65/45/25/10 (`confidence-dimensions.ts:159`).
4. Case-rollup weights 0.7/0.3 and the relationship penalty ÷2 — undocumented
   (`confidence.ts:53, 57`).
5. Frontend `adjustedConfidence` re-adds a corroboration bonus **on top of the
   already-capped stored value without re-applying caps** (`intel.ts:227-259`),
   so a backend-capped 85 can display as 95 (F-4). The bonus's class set is a
   naive first-token split that over-counts (`whois`+`whois_lookup` = 2 classes).

**Recommendation:** pick ONE corroboration curve, ONE analyst-delta set, ONE
recency curve; make the frontend display the stored (capped) number verbatim and
stop re-inflating it. That single change resolves F-2, F-4, and most of the
"arbitrary" perception.

---

## 7. Priority summary

| ID | Finding | Severity | Action |
|---|---|---|---|
| F-4 | Frontend re-inflates above the backend cap | High | Display stored value verbatim |
| G1 | Numeric tier lacks the independence gate (single court/gov → "Confirmed") | High | Gate numeric tier on independentClasses≥2 |
| G2 | `meta.reviewed` may launder into CONFIRMED | High (if model-writable) | Verify write path, then gate |
| F-2 | Confirm applies +20 but explains +15 | Medium | Single delta constant |
| §0 | Four parallel confidence systems | Medium | Consolidate to one score + one tier map |
| §1 | Tier cut-point drift (55/35 vs 50/30) | Low | Reconcile |
| §3 | "Address"/"50" are un-ruled/overloaded | Low | Add explicit classes |

All changes above are **proposals pending owner sign-off** — none were applied in
the accompanying PR, which limits itself to the non-integrity tool-health and
timeout fixes.
