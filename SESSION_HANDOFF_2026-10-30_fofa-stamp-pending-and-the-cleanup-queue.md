# Session handoff — 2026-10-30: FOFA fix merged, stamp pending, cleanup queue

Written at ~04:55Z when the session ended after its second compaction. Every number below
was measured then. Re-measure before you act on any of them.

## 1. State at handoff

- `main` = `9c5c655` (#908, FOFA `as_organization` fix). It is merged but **not deployed**.
- Live `osint-agent` = `6eb444f`. `deploy/live` = `6eb444f`. Mirror `origin/main` = `454a48e`.
- **Merge freeze:** nothing may merge to `main` until stamp **#911** merges. The stamp must merge
  while `main` is still `9c5c655`, so that the stamp's parent is the marker commit.
- **JD's standing authority** (this session): "You have my approval take over and do what's best
  stop asking". This covers merging, deploying and fixing. CLAUDE.md's SETTLED items and protected flags still
  stand: `REVEAL_BREACH_DATA` ON, `RUN_LEASE_DISABLED=true`, `MAX_PAID_CALLS` bounded, GLM primary,
  no secret or flag changes, one edge PR in flight, and frontend and edge never mixed in one PR.
- At the very end JD said "stop and wait". Confirm with JD before resuming deploy work.

## 2. Open PRs

| PR | What | Channel | State at handoff |
|---|---|---|---|
| #911 | Stamp `BUILD_MARKER` → `9c5c655` | edge | Green, Codex clean. **Merge first.** |
| #903 | Durable-run telemetry design (docs) | docs | Green; Codex P2 fixed in `9ede252` |
| #906 | `run-insight-finder` skill + driver | tooling | Green; Codex P2 fixed in `809671f` |
| #907 | `.claude/settings.json` read-only allowlist | tooling | Green; Codex P2 fixed in `66ddbdb` |
| #910 | Custody-coverage count fix (`src/lib/custody-coverage.ts`) | frontend | Green, Codex clean. One Graphify advisory (two separate 5000-row caps), unverified |
| #912 | Evidence `artifact_id` writer fix in `record_artifacts` | edge (draft) | Green. Held until the #908 deploy cycle closes |
| #913 | Remove 31 unused UI primitives, 3 dead files, 23 packages | frontend (draft) | Typecheck and lint pass; vitest and build run in CI; **e2e not yet run by hand** |

Other open items: #738 is superseded by #831 and can be closed. #772 and #804 need triage.

## 3. Exact next steps (in order)

1. **Finish the #908 deploy** using the `edge-deploy` skill.
   1. Merge #911.
   2. Push the mirror branch `sync/fofa-fields-9c5c655`. It was in the old container only and is lost, so recreate it. Surgically copy `supabase/functions/osint-agent/tool-registry.ts` and `build-info.ts`, check that `diff -rq` against canonical is equal, then open and merge the mirror PR.
   3. Run `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live`, then `npm run verify:deploy -- --previous 6eb444f --mirror ../seeker-spark-search-5362c57c`. It must show `mirror tree -> equal` and `mirror pushed`.
   4. Send the Lovable message to project `4ce11bc3-039d-4439-b293-acacca9e1e3a`. It should say: pull `main`, confirm `BUILD_MARKER` is `9c5c655`, then run `supabase--deploy_edge_functions` with `["osint-agent"]`. No `deploy_project`.
   5. Read `/health` and check that the build is `9c5c655`.
   6. Run `npm run record:deploy -- --previous 6eb444f --mirror …`, push `deploy/live`, then merge the ledger PR.
2. **Merge the green frontend and docs PRs:** #903, #906, #907, #910. Re-check CI and Codex on each head first. For #910, also run `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e` first; baseline is 95 passed / 13 skipped.
3. **#913:** run vitest, build and e2e locally. If all pass, mark it ready, wait for Codex, and merge.
4. **#912:** mark it ready, wait for Codex, merge, then run the full deploy cycle again. Afterwards, check that new `evidence_log` rows carry a non-null `artifact_id`.
5. **Follow-ups**, not started:
   - Remove `leaflet`, `react-leaflet` and `@types/leaflet`. Nothing in `src` imports them; only a `vite.config.ts` chunk rule and the `.cyber-map` CSS mention them.
   - Decide about the stale `bun.lockb`. Check whether Vercel installs with bun before deleting it.
   - Wire `artifact_id` into the remaining `append_evidence` writers: `tools/recording.ts`, `auto-persist-findings.ts`, `cache.ts`, and the other call sites in `tool-registry.ts`.
   - Find out why DeepFind returns 403: `deepfind_disposable_email` failed 6 of 6 calls and `deepfind_ssl_inspect` 4 of 4. Probably a plan or account issue.

## 4. Measurements from this session

- Production, 14 days: 124 runs = 75 `finalize_forced` / 45 `natural_stop` / 4 `stream_error`.
- Tool failures:
  - FOFA failed 7 of 7 calls; #908 fixes it.
  - `crtsh` hit upstream 502s.
  - `gemini_deep_dork` timed out 9 of 22 times at 20 s. That cap is deliberate (`cache.ts`); don't raise it.
- All 17,575 `evidence_log` rows have a NULL `artifact_id`, because every writer hard-codes it. #910 fixes the coverage stat and #912 fixes the main writer.
- The #899 timing columns exist in production (9 columns, all nullable).
- Baselines on `9c5c655`'s parent `6596812`: edge 2821/0/6, frontend 2965/1/247, e2e 95/13.

## 5. Subscriptions and check-ins

The old session held subscriptions to #903, #906, #907, #910, #911, #912 and #913. **The new
session must re-subscribe** (`subscribe_pr_activity`) and arm its own `send_later` check-in. The
old safety-net check-in `trig_01KwjzrRJy62YDiqaSohi5dy` was deleted at handoff.
