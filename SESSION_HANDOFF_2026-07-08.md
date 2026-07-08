# Session Handoff — 2026-07-08

Branch: **`feat/type-scale-tokens`** → **PR #270** (all work below is pushed there).
Deploy: frontend ships by merging PR → `main` → Vercel. Build green, **898/898 tests pass**, typecheck clean.
Design system: `impeccable` skill, `PRODUCT.md` = "glass forensic console" (Sora/display + sans body + **mono is a data face only**).

## What shipped (newest first)

| Commit | Change |
|---|---|
| `7292f57` | Evidence table: 2-column tile grid (was one full-width column → ~1100px stretched bars). |
| `78e96a7` | Evidence sticky filter bar shrunk 132→89px: scoring legend pulled out of the sticky region so it scrolls away (fixes "top area stays" on short viewports). |
| `09b4200` | Evidence: click-to-copy directly on each artifact value (hover copy glyph, toast, focus ring). |
| `f26b6d6` | Pivot cards: font fix (mono→sans for labels/"Run" button; mono only on the value), click-to-expand mini-brief, even collapsed heights (`sm:items-start` + min-h), focus states, 200ms transitions. |
| `0347674` | Pivot cards: even 2-up grid, equal heights, "Run pivot →" affordance, dropped banned side-stripe. |
| **`8dd643b`** | **⭐ Pivots stop re-suggesting already-run targets** — see below. |
| `8716dff` | Chat empty-state compressed so Seed/Route/Reveal steps aren't cropped. |
| `48510ae` | Case/chat titles show clean selector via `extractDisplaySeed` (was dumping the whole run-prompt); report-header overlap fixed (removed nested `max-h-[78vh]` scroll → single scroll container); collapsed sidebar capped to active + 7 recent (was all ~140 cases as tiny icons). |
| `1cc96d2`, `f81bf13` | B1: selective uppercase demotion across the investigation view + stats surfaces (mono/sans + size/weight carry hierarchy; kept status badges + per-item data-type tags + one eyebrow per surface uppercase). |
| `b90cb0f`, `f45e3a7` | Insights: server-side aggregation RPC (`get_insights_summary`) so stats reflect ALL rows (PostgREST 1000-row cap); Activity sparkline fix. |
| `f80fbd3`, `62284cf` | Type scale + micro-type floor + single data face; HomeHub de-dup + landing tokens. |

## ⭐ The pivot already-run fix (`8dd643b`) — the important one

**Symptom:** "Next steps" re-suggested pivots for targets already fully investigated; clicking one → agent replied "duplicate, already investigated." Also duplicate-looking cards.

**Root cause (verified against PROD via Lovable `query_database`):** artifacts carry **no parent/seed lineage** (`metadata.parent`/`parent_seed`/`seed` are null on real cases), so `computePivots` couldn't tell a discovered email had been searched. **The authoritative already-run signal is `tool_usage_log.input_json.runtime.selector`** — it records exactly what each tool ran against (e.g. `cerodeb@yahoo.com` was hit by 7 tools).

**Fix:**
- New hook `src/hooks/useThreadQueriedTargets.ts` reads that log → `Set` of normalized targets (realtime-subscribed).
- `computePivots` gained an optional `queriedSet` input; a pivot whose target is in it is demoted `new`→`searched` (so the chat rail only shows genuinely-unrun leads; already-run ones sink to the Pivots tab). Optional arg = existing callers/tests unchanged; **3 new unit tests** pin it.
- Wired into `ChatWindow` + `PivotsTab`.

**Verified live:** stale `cerodeb@yahoo.com` + LinkedIn pivots vanished, replaced by real unrun leads (`debracero@comcast.net`, two discovered phones).

If pivots regress: check `queriedSet` wiring + that the tool log is populating `runtime.selector`.

## Still open / next candidates (user selected these; not done)
- **Tools tab interactivity** (inline expand, copy, filters) — Activity already `max-w-4xl`.
- **Graph tab polish** — tiny/unreadable node labels, zoom-to-fit, empty-state overlap.
- **Case-header subtitle** still spans full header width uncapped (candidate for the same de-stretch cap; user was asked, no answer yet).
- Integrity PRs parked for sign-off (unchanged): `#189` dedup migration (held — unsafe, corrected SQL in a comment), `#198`, `#248`.

## Verify commands
- Frontend tests: `npx vitest run` (898 pass). Typecheck: `npx tsc --noEmit`. Build: `npm run build`.
- Dev server runs on `localhost:8080` (user's authenticated session used for live verification throughout).
