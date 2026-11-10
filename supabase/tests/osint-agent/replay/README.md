# L1 replay harness

Re-runs today's deterministic engines over one case's **stored rows** and writes a
scorecard. No network, no database, no model, no edge-function change. It is the
instrument every later phase of the 2026-11-10 master plan is gated on: a change to
clustering, attribution or pivot ranking is measured here before it touches a live case.

| File | What it is |
|---|---|
| `snapshot.sql` | Read-only export of one thread (artifacts, analyst reviews, tool log) as one JSON value |
| `snapshot.ts` | Snapshot parser; sorts rows so a replay never depends on arrival order |
| `scorecard.ts` | Runs `lib/cluster.ts` and the attribution sandbox; `summary` = counts only, `details` = ids and value slices |
| `attribution-rules.ts` | **Shadow-only** sandbox: the v1 node rule (four readings) and the v2 edge rule, scored against the analyst's verdicts. Nothing in product code imports it |
| `co-record-fields.ts` | Zero-import copy of `CO_RECORD_FIELDS`, pinned by `src/test/replay-co-record-pin.test.ts` |
| `replay.ts` | CLI |
| `fixtures/*.json` | **Synthetic** cases, one per measured defect |
| `replay_test.ts` | Runs in `npm run test:edge` |

## Run it on a real case

⛔ The repo is public. A real snapshot and its scorecard contain real people's data:
they live only in `src/dev/raw/` and `replay-out/`, both gitignored. Never commit them,
paste values into a PR, or attach the scorecard file anywhere.

1. Open `snapshot.sql`, put the thread id on the `params` line, run it in the Supabase SQL editor.
2. Save the single JSON value it returns as `src/dev/raw/replay/<name>.json`.
3. Run the harness.

PowerShell:

```powershell
npm run replay -- src/dev/raw/replay/<name>.json
```

bash:

```bash
npm run replay -- src/dev/raw/replay/<name>.json
```

It prints the counts summary and a hash, and writes the full scorecard to
`replay-out/<name>.scorecard.json`. Share the printed summary only.

Kill switches: `lib/cluster.ts` reads its `CLUSTER_*` switches at call time. Unset means
the production default. To replay a switch flipped, set it in the environment first.

## Reading the scorecard

- `evidence` — how much of the case is tool-derived vs typed by the model or analyst,
  how many rows are bare selectors, and how many are written prose (`finding`, `other`,
  `note`, `weak_lead`, `contradiction`, `ai_summary` rows).
- `clustering` — today's `clusterArtifacts` result: joins by rule, written rows sitting
  inside shared clusters, clusters held together **only** by written rows (a
  counterfactual run with them removed), nameserver/mail-host joins, and analyst-released
  rows that clustering still treats as inert.
- `attribution` — what each rule would label "auto-corroborated":
  - `v1_*` — the overhaul's node rule, read four ways (`literal`/`counted` ×
    `strict`/`engine`). `on_vetoed_selectors` counts decisions on a selector the case
    itself contradicted, excluded or rejected.
  - `v2_edge` — the edge rule. `blocked_by_origin` = would qualify if model-typed rows
    counted; `selectors_without_edges` = selectors no record links to anything.
  - `keep` = analyst Confirm; `key_only` = analyst Key (importance, **not** attribution);
    `reject` = Dismiss/Wrong.

## KNOWN-DEFECT tests

Tests named `KNOWN-DEFECT (master plan 1c/1d)` pin today's behaviour. The PR that fixes
the defect must flip the assertion in the same change, on purpose, with review.
