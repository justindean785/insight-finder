# Plan adjustment — 2026-09-01 (Lovable audit + bruh124blue scan)

Supersedes priority ordering in the original audit plan. **REVEAL_BREACH_DATA stays ON.**

## What changed

The Lovable production audit (10 threads) identified **finalize window at 90s** as the structural blocker for `minimax_correlate` — not hint delivery alone. The bruh124blue@gmail.com scan (same day) shows correlate **can** succeed when timing aligns (`minimax_correlate`×2, 8 clusters), but most recent runs still show 73–100% orphans.

## Revised root-cause stack

| Layer | Issue | Evidence |
|-------|--------|----------|
| L1 | Finalize reserve blocks correlate at 90s+ | Lovable: 5/5 correlate calls skipped; code: `cache.ts:1084`, not in `ALWAYS_ALLOW_TOOLS` |
| L2 | Hint delivered too late | #531 / thread 15ebf7d4 |
| L3 | Auto-persist counter invisible to trigger | Fixed #530 |
| L4 | Single 180s isolate caps complex cases | Lovable regime change: 110–130s / 20–26 calls vs 320–580s earlier |
| L5 | Provider hygiene | Jina 403, RapidAPI 403, dead github/reddit in planner, timeout mis-calibration |

## bruh124blue@gmail.com — case study (25 artifacts, ~126s)

### Solid
- Breach stack: serus, breach_check, rapidapi, leakcheck, oathnet, hibp password kanon
- **Correlate ran twice** — clusters present (`cluster_id: bruh124blue` on late artifacts)
- Integrity caps honest (55–60, single breach class)
- Reveal working (passwords in `concrete_values` / hash artifacts)
- Weak-lead negative search recorded

### Weak (new P1 items from this scan)
- **Breach row explosion**: 2 generic + 6 batched serus + 4 oathnet + leakcheck = many near-duplicate `breach_exposure` rows for one email
- **Engine findings empty**: report says "scoring engine adjudicated no findings" despite 25 artifacts and 8 clusters
- **Identity not unified**: Adrian Veg / blue cuh / doxbin stay separate clusters; no pivot to username `doxbin` or discord stealer follow-up
- **LeakCheck provenance**: `llm_asserted_unverified` on metadata
- **Generic pivots**: recommended next steps don't surface `doxbin` or Fairfax address as one-click pivots

## Revised execution order

### Phase 0 — Correlate unblock (in progress on `cursor/correlate-finalize-fix-4abb`)
1. Merge #531 hint delivery + **finalize window exemption** for `minimax_correlate` + defer finalize when correlate due and never attempted
2. Stamp, mirror sync, Lovable deploy, verify `/health`
3. Re-test address seed (15ebf7d4 shape) AND email seed (bruh124blue shape)

### Phase 1 — Merge queue (unchanged)
- #491 address dorks, #529 linkage release, #519 dispatch paging

### Phase 1b — NEW: breach artifact hygiene (from bruh124blue + Lovable P3)
- Collapse duplicate `breach_exposure` per (email, corpus) at auto-persist write
- Batch serus multi-corpus returns into fewer rows (metadata.items)
- Do NOT mask or change REVEAL_BREACH_DATA

### Phase 2 — Finding synthesis + pivots
- Wire dark `finding-synthesis` OR ensure correlate output feeds engine findings (0 adjudicated today)
- Surface high-value pivots: username from breach (`doxbin`), address (`Fairfax, VA 22032`)
- Report authority prompt (Evidence Record only)

### Phase 3 — Provider hygiene (Lovable P2)
- Jina key, RapidAPI hosts, retire dead tools, timeout p95 alignment

### Phase 4 — Workbench UI + connection engine (unchanged from original plan)

### Phase 5 — Multi-generation runs (Lovable P1 long-term)
- Resumable investigations across isolates; cannot shorten finalize reserve safely without this

## Deprioritized / unchanged
- REVEAL_BREACH_DATA / masking — off limits per operator
- SSN-in-value composition — still deferred
