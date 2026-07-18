# Investigation Logic — How It Works & Improvement Plan

**Grounded in a real run** (a CDCR/LASD record-screenshot investigation of a named person). Every claim is cited to code. Two defects from this run are **already fixed in PR #342**; the rest is the prioritized roadmap.

The pipeline has 8 stages. The core problem the run exposed: **the deterministic logic (classification, clustering, collision, confidence) is sound in places but (a) has classifier gaps, (b) runs *after* the model already streamed its answer, and (c) the report reads different metadata than the engine writes** — so good analysis gets computed and then hidden.

```
UPLOAD/SEED ─▶ EXTRACTION ─▶ CLASSIFICATION ─▶ RECORDING+CONFIDENCE ─▶ CLUSTERING ─▶ COLLISION ─▶ REPORT
   (auth.ts)   (gemini_vision   (validation.ts   (recording.ts        (cluster.ts)  (contradictions (intel.ts /
                +attachment-      + selectorKind)  + confidence.ts)                   .ts)          CaseReport)
                intake)                                                                       └▶ RECOVERY (recovery.ts)
```

Surfaces: **Frontend** ships via Vercel on merge; **Backend** (`supabase/functions/osint-agent/**`) needs the gated Lovable edge deploy.

---

## Stage 1 — Extraction (image/OCR → structured fields)

**How it works:** `gemini_vision` (`tools/gemini_vision.ts:178-271`) returns `{visible_text, watermarks, handles, attributes, scene, confidence}` — it records nothing itself. The system prompt tells the model to put "any @handles, usernames, URLs, cashtags visible" into `handles` (`:147-155`). A record-page screenshot has the browser URL bar visible, so the site host legitimately lands in `handles`.

**Broken:** the *host of the page we're reading* is captured as if it were the *subject's* handle. There is no notion of "page chrome / provenance vs. subject selector."

**Fixes**
- **[P1, backend]** Add a `page_url`/`site_chrome` field to the vision schema (`gemini_vision.ts:147-155`) so hostnames are captured as **where we looked**, not **who the subject is**; intake records them as `metadata.observed_on_site`, never a selector.

---

## Stage 2 — Classification (string → artifact kind)

**How it works:** two independent classifiers, and **the image path uses the one that bypasses the main validator**:
- `attachment-intake.ts::selectorKind` (`:67-76`) for image/doc selectors — **does not call `validateArtifact`**.
- `validation.ts::validateArtifact` (`:246-428`) for `record_artifacts`.

**Broken (the headline bug):** both username branches accepted a dotted hostname (`app5.lasd.org`) as a `username`. ✅ **FIXED in PR #342** — both now reclassify a dotted host with a recognized public suffix to `domain` (gated so `john.doe` stays a handle).

**Remaining fixes**
- **[P2, backend]** Other missing guards in `validateArtifact`: no all-digit-username guard; the subdomain reclassifier (`:275-279`) only fires for a fixed prefix whitelist (`www./crm./…`), so `app5.`/`ciris.` government hosts have no path to `subdomain`. Broaden it to any valid registrable host.
- **[P2]** `STRICT_PASSTHROUGH` kinds (`:254-263`) accept `social_profile/court_case/breach_exposure/…` on length only — no value-shape check. Low risk but worth tightening.

---

## Stage 3 — Recording + Confidence (the cap engine)

**How it works:** `applyEvidenceCaps` (`confidence.ts:310`) caps raw model confidence by **source class**. Class comes from `classifySource` (`source-classification.ts`), which **substring-matches a free-text `source` string the model writes** (`:304,316`: `/court|docket|cdcr|bop|pacer/ → court_record`, cap 90). `deriveStatus` grants `"verified"` whenever there's no open reason — **even at a single source class** (`confidence.ts:619-624`).

**Broken (integrity hole):** a single `gemini_vision` OCR of a **user-uploaded image** self-declared `court_record` and was laundered to **conf 90 / status "verified"** with `dob/race/gender` attached — because the cap engine keys on the model's free-text label and **ignores the true tool provenance** (`inferred_from_vision`). One uploaded image ≠ a verified court record.

**Fixes**
- **[P0, backend, sign-off]** In `applyEvidenceCaps`, gate `court_record`/government/official caps behind **tool-verified provenance**: if `metadata.provenance ∈ {inferred_from_vision, extracted_from_document}`, cap as `ai_summary` (55) regardless of the free-text label. File: `confidence.ts` (+ thread the provenance tag).
- **[P0, backend, sign-off]** `deriveStatus` must require `independent ≥ 2` for `"verified"` on identity kinds (name/person) so one class → `"observed"/"needs_corroboration"`, not "verified." File: `confidence.ts:601-625`.
- **[P1]** Narrow the `court`-substring regex so a bare `"court record"` token on a vision artifact can't outrank its real `gemini_vision` slug. File: `source-classification.ts:304,316`.

> These are integrity-critical (confidence caps) — **explicit sign-off required** before changing.

---

## Stage 4 — Clustering (identity grouping)

**How it works (backend):** `clusterArtifacts` (`lib/cluster.ts:281`) union-finds over **strong selectors only** (`email/phone/handle/domain/acct/self-admission`, `:195-229`); **names are deliberately never a merge key** (collision axis). Runs once at end-of-run in `onFinish` (`index.ts:1218`) — **after the assistant message is already streamed**, so the in-chat report never sees the deterministic `cluster_id`/`promoted_confidence`. The **frontend** report recomputes its own clusters via `buildIdentityClusters` (`intel.ts:1529`).

**Broken:**
1. A hostname-as-handle became a **merge key** (`cluster.ts:203-204`) — two shots of the same portal could fuse into one "identity." ✅ Root-fixed by Stage 2 (no more hostname handles).
2. **7 single-selector "cameron elijah lawson" clusters** — a `name` artifact with no concrete selector gets its own bucket (`intel.ts:1661-1663`) and always qualifies as a cluster (`report-hygiene.ts:152`). ✅ **Partially fixed in PR #342** (namesakes now quarantined, cutting the count); full de-fragmentation still open.

**Fixes**
- **[P1, frontend]** Collapse single-artifact `name/person` buckets that share an identical normalized name and carry no distinct selector (merge before rendering). Files: `intel.ts:1659-1691`, `report-hygiene.ts:148-159`.
- **[P2, backend]** Run clustering (or at least surface `excluded`/contradiction rows) **before** final synthesis, or feed the deterministic subjects back into the report context, so the model's answer reflects real merges. File: `index.ts:1211-1222`.
- **[P2, backend]** Defense-in-depth: skip domain-shaped handle tokens in `cluster.ts:203-204`.

---

## Stage 5 — Collision / Contradiction (namesake detection)

**How it works:** `detectContradictions` (`contradictions.ts:334-476`) finds `location/employer/name_conflict/common_handle/thin_name/over_broad/…`. But **only** location/employer/name (those with `field`+≥2 `claims`) get **persisted** as structured patches (`:521-553`); the rest are returned to the tool call and **never written**. The automatic same-value writer (`recording.ts:145-181`) only fires for **phone/email/address**, not username/name. `excluded_collision` is stamped only when `isUnrelatedEntity` fires, and that helper reads only `note/reason/relationship` — **not** `status`, `cluster`, or `reason_not_confirmed`.

**Broken:** the engine *correctly detected* the collisions (a profile `status:"excluded"` "not Cameron Lawson"; a `cluster:"B - Tennessee collision"`), but wrote them in fields the report didn't read. ✅ **FIXED in PR #342** on the read side (`isCollisionArtifact` + report now honor `status:"excluded"` and free-text collision reasons).

**Remaining fixes (close the write side)**
- **[P1, backend]** Teach `isUnrelatedEntity` / the record path to also treat `status:"excluded"` and collision `reason_not_confirmed` as a collision, so the boolean + `kind:excluded_collision` are set at write time (not just inferred at render). Files: `confidence.ts:496-507`, `tool-registry.ts:4348-4362`.
- **[P1, backend]** When a high-severity `name_conflict` is found, emit a real `kind:"contradiction"` row (or `status:"contradicted"`) instead of only appending to `metadata.contradictions[]`, and stop depending on the optional `detect_contradictions` tool being called. Files: `contradictions.ts:409-418`, `recording.ts:145-181` (extend to username/name).

---

## Stage 6 — Report generation

**How it works:** the markdown report is **frontend** (`intel.ts::buildReportMarkdown`), rebuilt from artifacts each render. Sections: subject, candidate clusters, key findings, artifact table, network, **Collision / Likely Unrelated**, corroboration, timeline, activity.

**Broken:** covered above — the collision section read different metadata than the engine wrote (✅ fixed), and clusters fragment (partially fixed). One more internal inconsistency: the cluster engine prints a "Potential same-name collision detected" **banner** (`intel.ts:1830-1860`) while the dedicated collision **section** said "none" — now reconciled by PR #342.

**Fixes**
- **[P1, frontend]** Also treat a non-empty `metadata.contradictions[]` as a contradiction signal in the report + `CaseReport.tsx:50-58`, so structured `name_conflict`/`location_conflict` entries surface without needing a separate `kind` row.
- **[P2, frontend]** Confidence-display honesty (ties into the Evidence Workspace 2.0 doc): one confidence source, explainability from the metadata that already exists (`reason_for_confidence`, `confidence_cap_applied`, `source_category`).

---

## Stage 7 — Recovery (stale-run fallback report)

**How it works:** `buildRecoveredAssistantText` (`recovery.ts:46-79`) sets subject = `seed_value || title || "this investigation"` **verbatim**; `escapeCell` only trims/escapes pipes — it does **not** strip the "Attached files:" block or URLs.

**Broken:** the report subject read `"Cameron Elijah Lawson Attached files: - [IMG_3116.png](https://…signed-url…)"`, and the seed was the raw signed storage URL. **Root cause upstream:** `auth.ts:255-268` derives `title`/`seed_value` from the raw first user message *after the composer appended the attachment block*, and nothing strips it (the `parseAttachments`/`MARKER` helper exists at `attachment-intake.ts:29` but is never called here). The same polluted text is re-parsed in 2 more places (`index.ts:311-319`, `:1117-1120`) with different truncation → the duplicate/divergent seed.

**Fixes**
- **[P0, backend]** Strip the "Attached files:" block **before** deriving `title`/`seed_value` in `auth.ts:255-268` (reuse `MARKER`/`parseAttachments`). Fixes the recovery report, the stored seed, and the duplicate-seed divergence in one place.
- **[P1, backend]** Defense-in-depth: sanitize `seed` in `recovery.ts:50-56`; strip/shorten raw URLs in the findings-table render (`:66`).
- **[P1]** Centralize seed derivation so `auth.ts`, `index.ts:311`, and `index.ts:1117` use one stripped value (removes the double `detectSeedServer` + divergence).

---

## Stage 8 — Pivots / Next actions

Covered in depth by `docs/EVIDENCE_WORKSPACE_2.0_DESIGN.md` (this run reproduced it: the bogus `ciris.mt.cdcr.ca.gov` "Verify username linkage" pivots — ✅ removed by the Stage-2 fix). Key open items: dedupe by action-intent, suppress generic/exhausted targets, deterministic ranking.

---

## Prioritized roadmap

| Pri | Item | Stage | Surface | Status |
|---|---|---|---|---|
| ✅ | Hostname→domain (both classifiers) | 2 | backend | **PR #342** |
| ✅ | Report surfaces `status:excluded` + free-text collisions; namesake quarantine collapses fragmentation | 5/6/4 | frontend | **PR #342** |
| **P0** | Confidence provenance gate (vision OCR can't self-declare `court_record`→90/verified) | 3 | backend, **sign-off** | planned |
| **P0** | `deriveStatus` requires ≥2 classes for "verified" on identity kinds | 3 | backend, **sign-off** | planned |
| **P0** | Strip "Attached files:" block before seed/title derivation | 7 | backend | planned |
| **P1** | Write-side collision: set `excluded_collision`/`contradiction` from `status`/`reason`/`name_conflict` | 5 | backend | planned |
| **P1** | De-fragment single-name clusters (merge identical no-selector name buckets) | 4 | frontend | planned |
| **P1** | Surface `metadata.contradictions[]` in report + CaseReport | 6 | frontend | planned |
| **P1** | Vision schema: capture page host as provenance, not a subject handle | 1 | backend | planned |
| **P2** | Cluster before synthesis / feed deterministic subjects to the report | 4 | backend | planned |
| **P2** | Broaden subdomain reclassifier; all-digit username guard | 2 | backend | planned |

**Suggested sequence:** (1) the three **P0** backend fixes as one reviewed PR (confidence provenance + deriveStatus + seed-strip) — these are the biggest accuracy wins and two need sign-off; (2) the **P1** collision write-side + report `metadata.contradictions[]` (closes the loop end-to-end); (3) **P1** cluster de-fragmentation; (4) fold pivot dedup/ranking in via the Evidence Workspace 2.0 plan.

**Integrity guardrails (unchanged):** confidence caps, `deriveStatus`, collision/minor-safety detection, and chain-of-custody are sign-off-required. Nothing here weakens a safety check; the changes make the tool **less** likely to over-claim or misattribute a named person.
