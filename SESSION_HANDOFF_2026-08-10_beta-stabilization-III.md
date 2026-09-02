# Session handoff — 2026-08-10 (evening) — beta stabilization III

> ## ⚠️ HISTORICAL RECORD — merged 2026-08-14, four days after it was written
>
> **This document is a dated measurement, not current operating truth.** It is on `main` so
> its evidence and reasoning survive; its *status* claims did not survive the week. Its own
> §1.0 is the reason this banner exists — a "verified green" reading in this project went
> false within six hours, because the mirror is writable by a second agent whose edits this
> repo never sees.
>
> Superseded as of 2026-08-14:
>
> | §  | Claim | Now |
> | --- | --- | --- |
> | §3, §14 | the PROMOTE boundary is the open P0 | **CLOSED** by #448. `isClusterIneligible` binds at all five call sites; the label boundary is capped too |
> | §3.2, §4 | `diagnostic/promote-boundary-repro` needs a PR | opened as #447, then **closed** — its file occupies the same path as #448's superset suite |
> | §4 | "30 PRs are open" | it was 34 at the time; several have since merged or closed |
> | §8 | frontend baseline 1211 / 1 / 102 | **1288 / 1 / 105** |
> | §1.0 | main HEAD `faf1305`, stamp gap three commits | main has moved; the marker gap is unchanged and still open |
> | §1.3 | `mcp` finding 1 (ownership ordering) open | fixed by #453 **and mirror-synced** (`b8e2056`) — though still not *verifiably deployed*, since `mcp` has no build marker |
>
> **Still true and still open:** the `/health` build marker names a commit that is not what
> runs (§1.0); `mcp` returns `artifacts` with `select("*")`, bypassing every integrity layer
> (§1.3 finding 2, §5.4); the dispatch guard (§3.7); breach-value persistence (§6); both
> canaries (§5.3); runs dying in the finalize window (§5.1).
>
> `CLAUDE.md` is the entry point and has been updated. Read it first; read this for evidence.

Third in the series. Read in order if you have time:
`SESSION_HANDOFF_2026-08-09_beta-stabilization.md` → `…_2026-08-10_beta-stabilization-II.md` → this.
If you have time for one, read **this one plus §11 (corrections)** — several load-bearing
facts in II and in `CLAUDE.md` are now false, and acting on them will waste a session.

Everything asserted here was measured today, against the live system, and the measurement
command is printed next to the claim. Where something was *not* measured, it says so.

---

## 1. The two things to take away

> **1. The deploy axis is, for the first time in this series, VERIFIED GREEN end to end.
> Frontend and backend both run current `main`. Do not lose this — every regression in
> this project's history started with someone assuming it.**
>
> **2. The PROMOTE boundary is open, and it is worse than II described. The existing
> gate catches ZERO of the 104 quarantined artifacts in production — not "some", zero.**

### 1.0 ⛔ SUPERSEDED WITHIN SIX HOURS — read this before §1.1

**§1.1 below was true when measured at 2026-08-10 22:00 UTC. By 2026-08-11 04:30 UTC it was
false, and the way it broke is the most instructive thing in this document.** §1.1 is kept
verbatim as the measurement it was; this section is what is true now.

*(Updated 09:45 UTC — `main` has moved twice more since this section was written; the stamp
gap is now three commits deep, though only #449 touches `osint-agent`, which is what the
marker actually tracks.)*

```
canonical main HEAD ............. faf1305  fix(mcp): settle thread ownership … (#453)
  └─ d9598f0  governance(mcp): fourth function under canonical review (#452)   src/lib/mcp/ only
  └─ 9fc6ce1  backport(orchestrator): vendor-agnostic lead slot (#449)         osint-agent ×3
build-info.ts BUILD_MARKER ...... e7e3f80   ← NOT re-stamped after #449
mirror origin/main .............. 054c3cb  "Made the requested updates"   ← Lovable-authored
mirror HAS DEEPSEEK_BASE_URL .... yes (8 occurrences)  ← #449's code IS on the mirror
mirror build-info marker ........ e7e3f80   ← not re-stamped either
live /health build .............. e7e3f80   ← names a commit that is NOT what is running
live selected_model ............. glm-5.2    (was deepseek-v4-pro six hours earlier)
```

**`/health`'s `build` field is currently lying, and this is the exact failure mode #444's
verifier is documented as unable to catch.** Not a hypothetical: §4.1 says "a post-sync
Lovable edit that leaves `build-info.ts` unchanged passes every current check." That is now
what happened.

The reconstruction, strongest evidence first:

1. The mirror's last three commits are `77efb9e "Changes"`, `a92d277 "Changes"`,
   `054c3cb "Made the requested updates"` — **Lovable-agent messages, not the
   `sync(osint-agent): … BUILD_MARKER …` shape the canonical recipe produces.** So the
   vendor-agnostic work was authored *in the Lovable project* and flowed mirror-first, then
   was backported to canonical as #449. That is the reverse of the documented direction.
2. Live `selected_model` is `glm-5.2`, so `DEEPSEEK_ORCHESTRATOR_MODEL_ID` was changed as a
   secret.
3. #449 is what introduces `DEEPSEEK_BASE_URL`; before it, the base URL is **hardcoded**
   `https://api.deepseek.com/v1` in three places (`env.ts` gateway, `health-handler.ts`
   probe, `index.ts` preflight). `checks.deepseek.ok: true` comes from a probe that really
   does `POST {model: "glm-5.2"}` to that URL — so a 2xx is only expected if the live code
   has `DEEPSEEK_BASE_URL` support and is pointing at Z.AI.

⇒ **The deployed code is post-`e7e3f80`; only the marker was never moved.**

**Residual uncertainty, stated rather than hidden:** #449 adds no new `/health` field, so the
endpoint cannot distinguish the two builds directly, and no deployed-byte digest exists. The
alternative — mirror synced but never deployed, with DeepSeek silently accepting a foreign
model name — is logically possible but would mean the orchestrator is running something other
than the `glm-5.2` it reports. Both readings are bad; they differ only in which instrument is
lying. The cheap decisive test is a run's orchestrator label, which #449 changes from
`glm-5.2 (DeepSeek)` to `glm-5.2 (api.z.ai)`.

**The fix is stamp → sync → deploy → verify, in that order, and stamping alone is not
enough** — the stamped `build-info.ts` has to reach the deployed function before `/health`
tells the truth again. Needs operator approval: it is a direct-to-`main` push plus a mirror
sync plus a deploy.

**The durable lesson, and it is bigger than this incident.** "Deploy axis verified green" has
a shelf life measured in hours, because the mirror is writable by a second agent whose edits
this repo never sees. A green reading is a *timestamped measurement*, never a state. Any
future handoff that says the deploy axis is clean must date the claim — and any reader must
re-run the four commands in §1.1 rather than trust the sentence.

### 1.1 The deploy state as measured at 2026-08-10 22:00 UTC — SUPERSEDED, see §1.0

```
canonical main HEAD ............. 2ebd330  chore(build): stamp osint-agent build marker e7e3f80
  └─ its parent ................. e7e3f80  fix(prompt): bind the credential policy to REVEAL_BREACH_DATA (#443)

build-info.ts BUILD_MARKER ...... e7e3f80
Lovable mirror origin/main ...... 33d676e  "sync(osint-agent): … BUILD_MARKER e7e3f80"
live /health build .............. e7e3f80   ← THE proof. Matches.
Vercel production ............... 2ebd330  target=production, state=READY
```

Read the one-commit offset correctly or you will chase a phantom: `stamp-build.mjs` writes
the marker for `HEAD` **at stamp time**, then that write becomes its own commit. So the
marker names the stamp commit's *parent*. `/health` reporting `e7e3f80` while `main` is
`2ebd330` is **correct and expected** — it means the deployed tree is `2ebd330`. A successor
who "fixes" this by expecting `/health == main HEAD` will re-stamp forever.

Verify it yourself, in this order:

```bash
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1" | jq
git log --oneline -2                                    # HEAD should be the stamp of /health's SHA
grep BUILD_MARKER supabase/functions/osint-agent/build-info.ts
diff -rq supabase/functions/osint-agent \
         ../seeker-spark-search-5362c57c/supabase/functions/osint-agent   # must print nothing
```

**Source parity is byte-clean for the four trees `CLAUDE.md` enumerates** (`diff -rq`, empty
for each): `osint-agent`, `evidence-export`, `security-test-lab`, `_shared`. This closes the
long-standing `evidence-export` drift that `CLAUDE.md` still warns about — see §11.

**⚠️ Read that sentence as scoped, because it was originally written unscoped and was
wrong.** It compares the trees `CLAUDE.md` says exist. It is **not** a statement that the
backend has no other functions. It does — see §1.3. Enumerate the directory; never take the
function list from documentation:

```bash
comm -13 <(ls insight-finder/supabase/functions/ | sort) \
         <(ls ../seeker-spark-search-5362c57c/supabase/functions/ | sort)   # → mcp
```

### 1.2 A whole-repo `git diff` between canonical and the mirror is NOT a drift signal

If you run this, you get an alarming number that means nothing:

```
git diff --stat canonical/main..HEAD   # → 306 files changed, +12,360 / −37,914
```

**That divergence is expected and permanent.** The mirror is not a fork of this repo — it is
a separate Lovable project that happens to hold a copy of `supabase/functions/<fn>/`. Its
frontend, its migrations (Lovable-style UUID filenames), and its absent test suite are its
own. Only the function directories are ever synced, one at a time.

An agent that runs the whole-repo diff concludes "these have diverged, you need a
reconciliation strategy" — which is one step from the blanket overwrite `CLAUDE.md` exists to
forbid, and which would destroy the Lovable project. **The only meaningful parity check is
`diff -rq` per function directory.** Both numbers are correct; they measure different things.

### 1.3 There is a FOURTH deployed edge function, and it is invisible to this repo

> **UPDATE 2026-08-11 09:45 UTC — two of the three findings below are now CLOSED, and the
> claim that the function "has never existed in canonical history" is now FALSE.**
>
> - **#452 (`d9598f0`)** brought the fourth function under canonical review — and did it the
>   right way: it canonicalized **`src/lib/mcp/`, the SOURCE** (index + 3 tools + README +
>   `src/test/mcp-contract.test.ts`, wired into `tsconfig.app.json` and `vitest.config.ts`),
>   **not** the Vite-plugin-generated `supabase/functions/mcp/index.ts`. That bundle correctly
>   stays out of canonical — importing it would give this repo a file it has no generator for
>   and that Lovable regenerates anyway. `ls supabase/functions/` on `main` is still
>   `_shared · evidence-export · osint-agent · security-test-lab`, and that is correct.
> - **#453 (`faf1305`)** fixed the `Promise.all` ownership ordering in finding 1: the
>   `threads` check is now awaited, and both the error and not-found returns fire, **before**
>   the `messages`/`artifacts` reads are issued (those two still run concurrently with each
>   other, which is right — they are subordinate to a settled check). Its comment states the
>   strength honestly: RLS *did* block cross-user rows, so this was never a demonstrated
>   isolation bug, only a guard that read as defence-in-depth while RLS was the sole control.
> - **STILL OPEN: finding 2**, the one that actually matters here — `artifacts` is still read
>   with `select("*")`, so raw metadata still leaves over MCP. See §5.4.
> - **NEW INSTRUMENTATION GAP:** #453 is a security-ordering fix to a **live** function, and
>   the `mcp` function exposes **no build marker** — there is no `/health` equivalent, so
>   there is no way to confirm the fix reached production. `osint-agent` at least has a
>   (currently stale, see §1.0) marker; `mcp`, `evidence-export` and `security-test-lab` have
>   none at all.

`supabase/functions/mcp/` exists in the mirror, is **live in production**, and — when this
section was written — had **never existed in canonical history** (superseded, see the update
above):

```bash
git log --oneline --all -- 'supabase/functions/mcp/**'   # → empty
curl -s -o /dev/null -w '%{http_code}' …/functions/v1/mcp   # → 401, i.e. deployed
```

`CLAUDE.md` line 3 says "**3 Deno edge functions**". There are four. The fourth is
`@lovable.dev/mcp-js`-generated (`AUTO-GENERATED … do not edit. Regenerated by the Vite
plugin`), so it will **reappear on regeneration** even if deleted — it is not a stray file,
it is a managed output.

What it is: an MCP server, `swarmbot-mcp` v0.1.0, exposing three tools — `echo`,
`list_investigations`, `get_investigation`.

**Its auth is competently built. Say so, and do not inflate this into a breach:**

| Control | Implementation | Verdict |
| --- | --- | --- |
| Token validation | `auth.oauth.issuer({ issuer: <project>.supabase.co/auth/v1, acceptedAudiences: "authenticated" })` | real JWT check, audience-pinned |
| Key used | `SUPABASE_PUBLISHABLE_KEY` (anon) — **not** service-role | correct choice |
| Caller identity | forwards `Authorization: Bearer ${ctx.getToken()}`, so RLS evaluates as the caller | correct |
| Per-tool gate | `ctx.isAuthenticated()` on both data tools | present |

The `401 unauthorized` an unauthenticated probe gets is that layer working, not a
misconfiguration.

**Two things are still worth a review, and the second is the one that matters here:**

1. **The explicit ownership check is defeated by `Promise.all`.** In `get_investigation`:

   ```js
   const [thread, messages, artifacts] = await Promise.all([
     sb.from("threads").select("*").eq("id", thread_id).eq("user_id", ctx.getUserId()) …,
     sb.from("messages").select("*").eq("thread_id", thread_id) …,     // no user filter
     sb.from("artifacts").select("*").eq("thread_id", thread_id) …,    // no user filter
   ]);
   if (!thread.data) return … "Investigation not found";                // already ran
   ```

   The ownership check runs *concurrently with* the fetches it is supposed to guard, and the
   "not found" return happens after they have executed. **Verified: no cross-tenant read** —
   all three tables have RLS on with `auth.uid() = user_id` SELECT policies (`pg_policies`,
   queried today). So RLS is the *sole* control on `messages` and `artifacts`, and the
   explicit check is decorative. Hardening gap, not a hole — the exact §2.1 shape where a
   correct check is unreachable in the shipped control flow.

2. **`artifacts` is fetched with `select("*")` — raw metadata — so this is an unmasked
   evidence egress path that bypasses every frontend integrity layer.** With
   `REVEAL_BREACH_DATA=true` that metadata carries concrete breach values. It also bypasses
   confidence caps, `labelForArtifact`, collision surfacing, and the `subject_unlinked`
   quarantine boundaries this entire handoff is about — a quarantined artifact comes back
   over MCP as an ordinary row with no flag interpreted. Because the function is not in the
   canonical repo, **none of the evidence-integrity rules were ever applied to it.** That is
   the reviewable finding: not "is it authenticated" (it is) but "does it honour the
   evidence contract" (it does not, because it never saw it).

**Do not hand any Supabase API key to an MCP client to reach this.** It authenticates a
*user OAuth token*, not an API key, so no key is needed. A **service-role** key would be the
worst possible choice for this endpoint specifically, since service-role bypasses RLS — the
one control actually protecting `messages` and `artifacts` per finding 1.

**But do not upgrade "synced" to "deployed" for the other two functions.** The Lovable
deploy call was `function_names: ["osint-agent"]`. `evidence-export` and
`security-test-lab` are byte-identical *in source* and their deployed state was **not
verified** — neither exposes a build marker at a health endpoint, so there is no
instrument for it. That is a gap in the verification story, not a green light. If an
export bug appears, suspect a stale deployed `evidence-export` first.

### 1.4 Live health, verbatim

```json
{"ok":true,"service":"osint-agent","version":"1.2.2","build":"e7e3f80",
 "build_committed_at":"2026-08-10T06:31:35-07:00",
 "selected_provider":"deepseek","selected_model":"deepseek-v4-pro",
 "orchestrator_reason":"pinned","orchestrator_active_ok":true,
 "checks":{"orchestrator":{"ok":true},"core":{"ok":true},
           "tools":{"ok":true,"detail":"16/19 optional tool APIs configured"},
           "deepseek":{"ok":true,"role":"active"},"minimax":{"ok":true,"role":"fallback"},
           "recovery":{"ok":true,"detail":"recovered 0 stale active run(s)"}},
 "intelbase_enabled":false,"reveal_breach_data":true}
```

`ok: true` is not beta-ready and never has been. It says the isolate boots, the providers
answer, and 16 of 19 optional tool keys are present. It says nothing about whether an
investigation produces a correct report — see §5.

---

## 2. What shipped since handoff II (merged AND deployed)

All of these are live. II described most of them as draft; that is the single biggest
staleness in II.

| PR | What it actually changed | Channel | Live? |
| --- | --- | --- | --- |
| **#433** | quarantine name-only collision roots (the WRITE boundary) | backend | ✅ `e7e3f80` |
| **#434** | bind `subject_unlinked` at the backend authority boundaries | backend | ✅ |
| **#436** | bind `subject_unlinked` at the frontend PIVOT boundary | frontend | ✅ `2ebd330` |
| **#437** | give a non-recording run a durability path (pre-nudge buffer + `decideBackstopAction`) | backend | ✅ |
| **#440** | report shows captured breach values instead of dropping them | frontend | ✅ |
| **#441** | surface `reveal_breach_data` at `/health` so the policy is verifiable | backend | ✅ |
| **#442** | `trimVictimItems` honours `REVEAL_BREACH_DATA` (oathnet victim parity) | backend | ✅ |
| **#443** | **the system prompt's credential policy follows `REVEAL_BREACH_DATA`** | backend | ✅ |

### 2.1 Why #443 was the one that mattered

"Breach values don't show" was five independent defects stacked, not one. Four are closed:

1. `trimVictimItems` had no `reveal` parameter — it masked unconditionally. (#442)
2. The victim tool's guidance string told the model "No raw credentials". (#442)
3. The tool *description* called `victim_file` "redacted" when it no longer was. (#442)
4. **The system prompt said, unconditionally, `NEVER paste full plaintext credentials`** —
   so with `REVEAL_BREACH_DATA=true` the tools handed the model real values and the prompt
   forbade it from printing them. The model complied with the prompt. It then wrote
   `"(masked, 12 chars)"` about a value it was holding in plaintext — **a false statement
   about the evidence**, which is worse than either mode alone. (#443)
5. **STILL OPEN:** `addCorpus` in `auto-persist-findings.ts` discards every breach field
   except the corpus name, so what the model *can* now print is not what gets *persisted*.
   Audit-only authorization; see §6.

The structural lesson from #443, which will bite again: **`system-prompt.ts` cannot import
`env.ts`.** Frontend vitest suites import the prompt module, and `env.ts` pulls
`npm:@ai-sdk/openai-compatible@1`, which Vite cannot resolve — the suite dies with a
transform error, not a test failure. The fix was a **leaf module**, `reveal-policy.ts`,
with zero imports; `env.ts` now re-exports from it. There is a structural test pinning
this (`system_prompt_reveal_policy_test.ts`) precisely so nobody reintroduces the import
and spends an hour on a confusing Vite error.

```
reveal-policy.ts   (leaf, no imports)  ←── system-prompt.ts   (safe for vitest)
        ↑
      env.ts  (re-export)              ←── everything backend
```

---

## 3. ⛔ THE OPEN P0 — the PROMOTE boundary

The 08-09 handoff named three authority boundaries for `subject_unlinked`:
**write · pivot · promote**. #433 closed write. #436 closed pivot. **Promote is open**, and
this session reproduced it against production data.

### 3.1 The decisive measurement

```sql
SELECT thread_id, count(*) AS quarantined,
       count(*) FILTER (WHERE (metadata->>'collision')='true'
                          OR (metadata->>'excluded_collision')='true'
                          OR (metadata->>'possible_collision')='true'
                          OR (metadata->>'status')='excluded') AS also_collision_flagged
FROM artifacts WHERE metadata->>'subject_unlinked'='true' GROUP BY thread_id;
```

| thread | quarantined | also_collision_flagged | max confidence | reviewed=true |
| --- | --- | --- | --- | --- |
| `f17ddf69` | 48 | **0** | 55 | 0 |
| `1deed1c1` | 24 | **0** | 55 | 0 |
| `98da3fb9` | 24 | **0** | 55 | 0 |
| `88cf94fa` | 8 | **0** | 55 | 0 |
| **total** | **104** | **0** | | |

That `0` column is the whole finding. The frontend's cluster gate is
`isCollisionArtifact()`, which tests exactly those four flags plus
`kind === "excluded_collision"`. **Not one of the 104 quarantined artifacts in production
carries any of them.** So the gate is not "leaky" — it is *inapplicable*. Every quarantined
artifact in the database is admitted to identity clustering.

II said the promote boundary was "unbound". The precise statement is stronger: the
existing exclusion mechanism and the quarantine flag are disjoint sets of signals that
were never connected.

### 3.2 The reproduction — already committed, deliberately failing

Branch **`diagnostic/promote-boundary-repro`** @ `394cd0b` (pushed; see §4 for its PR).
One test, one file, no fix, CI red **on purpose**.

```bash
git checkout diagnostic/promote-boundary-repro
npx vitest run src/test/promote-boundary-repro.test.ts
```

```
× REPRODUCTION: quarantined artifact ids must not appear in any cluster's member list
  → expected [ …(6) ] to deeply equal []
  + [ "0f19bbfc-…", "c97b3628-…", "5cd06c92-…",
      "b40c485f-…", "dca13bb5-…", "81a8a3b8-…" ]
```

The fixture reproduces thread `88cf94fa`'s exact shape — **real artifact ids, kinds,
confidence values, source, and `subject_unlinked` flags pulled from the live DB** — with
**synthetic values** (email/phone/address strings), because `CLAUDE.md` forbids real
investigation PII in this repo and the leak does not depend on what the values are.

**Read the "6 of 8" carefully.** The two that did not leak (`ip_address`,
`breach_exposure`) are **not protected by anything**. They produce no clustering signal
because `signalsFor` does not extract a key for those kinds. Add one clustering signal for
either kind — a perfectly ordinary future change — and the number becomes 8 of 8 with no
warning. Do not read the 2 as partial coverage; there is no coverage.

### 3.3 The blast radius — five surfaces, not one

`buildIdentityClusters` (`src/lib/intel.ts:1603`) is called from five places. Every one
inherits the leak, and three of them apply *their own* predicate that also omits
`subject_unlinked`:

| # | Call site | What the analyst sees | Own predicate? |
| --- | --- | --- | --- |
| 1 | `src/lib/intel.ts:1040` (`buildIntelReport`) | the markdown report's cluster section | — |
| 2 | `src/components/panel/ClustersTab.tsx:48` | the **Graph / Clusters tab** | — |
| 3 | `src/lib/confidence-dimensions.ts:117` | the **Identity confidence score** | `isConflicted` `:89` — omits it |
| 4 | `src/lib/entity-graph.ts:192` | the **entity graph** nodes/edges | `isConflict` `:150` — omits it |
| 5 | `src/lib/audit/from-artifacts.ts:108` | `artifactsToClusterAudit` → **ReportVerdict** | — |

Site 3 is the nastiest: it passes the **full** `artifacts` array (not its own filtered
`live`), so quarantined rows drive the headline Identity percentage. Site 5 means the audit
surface — the thing meant to *catch* over-statement — is computed from the contaminated
clusters and will certify them.

### 3.4 The THIRD leak nobody has named yet: the label boundary

`labelForArtifact` (`src/lib/intel.ts:336`) never consults quarantine either. Two paths
reach a promotion:

```ts
// intel.ts:349 — the attestation short-circuit
const attested = review === "confirmed" || review === "key" || meta.reviewed === true;
if (attested && meta.possible_minor !== true) return "CONFIRMED";
```

- **Analyst attestation** promotes a quarantined row straight to `CONFIRMED`. Note the
  shape of the existing carve-out: `possible_minor` is already exempted from this
  short-circuit precisely because a hard floor must survive attestation. `subject_unlinked`
  needs the same treatment and does not have it.
- **No attestation at all** still reaches `CONFIRMED` via the multi-source path at the
  bottom (`c >= 85 && independentClasses >= 2`).

`CONFIRMED` is not cosmetic — it leads Key Findings, feeds the "Confirmed" KPI bucket, and
skips value sanitization on export. Today nothing in production has `reviewed=true`
(the table above: `reviewed_true = 0` everywhere), so this path has not fired yet. It is a
loaded gun, not a smoking one.

### 3.5 The backend already does this correctly — copy it, don't invent it

```ts
// supabase/functions/osint-agent/lib/cluster.ts:136
export function isExcluded(a: Artifact): boolean {
  return a.kind === "excluded_collision" || metaBoolTrue(a.metaRaw, "excluded_collision") ||
    /"status"\s*:\s*"excluded"/i.test(a.metaRaw) ||
    metaBoolTrue(a.metaRaw, "subject_unlinked");        // ← the frontend has no equivalent
}
```

The frontend's `isCollisionArtifact` (`src/lib/report-hygiene.ts:108`) is that function
minus the last line. The divergence is the bug.

### 3.6 Fix shape — and the trap in the obvious version

**Do NOT simply widen `isCollisionArtifact`.** It looks like the one-line fix and it is
wrong. That predicate is also the membership test for the report's *collision section* at
`intel.ts:1099`, and #431 already renders quarantined rows there through a separate path
(`intel.ts:1129–1153`, reading `subject_unlinked` and `subject_unlinked_reason`). Widening
it double-lists every quarantined artifact in the report and changes an
evidence-presentation surface as a side effect of a clustering fix.

The shape that holds:

1. **New shared predicate**, exported once — e.g. `isClusterIneligible(a) =
   isCollisionArtifact(a) || isSubjectUnlinked(a.metadata)`. Leave `isCollisionArtifact`
   untouched so the collision section keeps its current membership.
2. **Apply it at all five sites in §3.3**, including inside `isConflicted`
   (`confidence-dimensions.ts:89`) and `isConflict` (`entity-graph.ts:150`). Five sites or
   the fix is partial, and a partial fix on this axis reads as closed.
3. **Site 3 additionally needs its `buildIdentityClusters(artifacts, …)` call reviewed** —
   passing the unfiltered array is a second, independent defect there.
4. **The label boundary (§3.4) is separate and is evidence-integrity-gated.** Excluding
   quarantined rows from the attestation short-circuit and capping their label is a
   *confidence-cap change*. `CLAUDE.md` requires sign-off for confidence caps,
   chain-of-custody, and ranking. **Do not fold it into the clustering PR.** Propose the
   cap, get the decision, ship it second.
5. **Failure-first, extended.** The current diagnostic covers site 1 only. Extend it to red
   on all five surfaces *before* touching `intel.ts`. Handoff II's §2.1 lesson applies
   directly here: green unit tests on this codebase confirm a helper does what its author
   meant, and miss the identity/timeline errors. Assert on **artifact ids appearing in
   output**, not on internal predicate returns.

### 3.7 The other half the operator asked for: quarantined selectors re-entering the tool queue

This is why runs feel spammy and burn the paid cap. Measured:

```bash
grep -rn "isSubjectUnlinked" tool-registry.ts index.ts tools/*.ts   # → EMPTY
```

**There is no tool-input quarantine guard anywhere in the backend.** Quarantine binds at
`graph.ts`, `recovery.ts`, `tools/recording.ts`, `auto-persist-findings.ts` and
`lib/cluster.ts` — i.e. at *write* and *read-back*. It does not bind at *dispatch*.

The consequence, and the thing to understand before designing anything: **there is no
selector queue to filter.** `buildIntermediateStepPlan` (`orchestrator-budget.ts:123`)
chooses `activeTools` and `toolChoice` — it never sees artifacts or selectors. The model
picks the next selector out of prior tool output in its context window. So a name-only
harvest that produced 8 quarantined selectors leaves 8 perfectly readable phone/address/
email strings in context, each eligible to seed its own multi-tool breach stack, and
nothing between the model's choice and the paid provider call.

That means the enforcement point is a **pre-flight guard on tool input** — refuse or
downgrade a paid lookup whose input value matches a quarantined selector for this thread —
**not** a filter on a queue. Design it as its own PR with its own evidence. Two hazards to
design against up front:

- **Provenance is per-row.** `src/lib/quarantine.ts:79` (`quarantineSets`) already got
  this right on the frontend after review: an identity goes inert only when *every*
  artifact carrying it is quarantined, keyed by **`type:normalizedValue`, not value
  alone**. `normalizeTarget` collapses non-alphanumerics, so `username "jordan.vale"` and
  `name "Jordan Vale"` both become `"jordan vale"` — keying by value alone let an ordinary
  name *restore authority to a quarantined username*. Any backend guard must use the same
  keying or it will reproduce that exact defect.
- **Do not turn a refused call into a burned step.** `repairUnknownTool` → `UNKNOWN_TOOL_SINK`
  returns `ok:true`, which is how `dork_harvest(completed)` reached a chain-of-custody
  record for a tool that has been `disabled: true` since 2026-07-09. A quarantine refusal
  must be legible as a refusal, in the run log and in the evidence export.

**Explicitly held for its own reviewed PR** (operator instruction, this session): relaxing
the mandatory 5-tool breach stack. It would reduce the same API spam from a different
direction and must not be bundled with either piece above.

---

## 4. Open PRs — what is actually in each, and what gates it

Nothing below is merged. **30 PRs are open — 29 drafts and exactly one ready for review
(#198, account deletion)**; these five are the ones this work touches. (An earlier draft of
this section said 21; that came from a single paginated page of 20 and was wrong. Count with
`perPage: 100` or `gh pr list --limit 100`.)

| PR | Branch | Contents | Gate |
| --- | --- | --- | --- |
| **#444** | `claude/insight-finder-beta-stabilization-sx80nc` | deploy-provenance recorder (`verify:deploy` / `record:deploy`, `deploy-log.jsonl`, 28 tests, `.d.mts`) | **Operator review. Do not merge.** CI green. |
| **#445** | `fix/evidence-count-header` | header evidence-count tooltip, both divergence directions | **Operator review. Do not merge.** CI green. Frontend → ships on merge. |
| — | `diagnostic/promote-boundary-repro` | the §3.2 failing test, no fix | needs a PR; **CI is red by design** |
| #438 | `claude/beta-db-security-sx80nc` | revoke `anon` EXECUTE on `record_analyst_feedback` | **already applied to the live DB**; the PR only records it |
| #435 / #430 | `fix/paid-call-accounting`, `claude/ui-frontend-audit-prs-59n7bi` | paid-call accounting + raisable cap | see §5.2 — do not merge either as a "fix" for the cap complaint |

### 4.1 #444 — read this before you form an opinion of it

The first version of #444 **overclaimed**, an operator review caught it, and the correction
is the valuable part. The verifier establishes that the SHA `/health` reports maps to a
real commit in canonical history whose stamp is consistent. It does **not** establish that
the deployed bytes are that commit's bytes. **A post-sync Lovable edit that leaves
`build-info.ts` alone passes every check in it.**

The corrected version says so in its own output and pins it with a test literally named for
the ceiling ("cannot detect a post-sync edit to a NON-marker file, and must not pretend
to"). The recorded verdict field is `markerProvenanceOk`, not `verified`;
`deployed_artifact_digest` is always `null`; `deployed_bytes_verified` is always `false`;
`proves` is the string `"observed-runtime-marker-maps-to-canonical-source-history"`.

Keep that naming. The failure mode this project actually suffers from is a tool that
reports a stronger guarantee than it has, and a successor who then trusts it.

---

## 5. Runtime blockers — reproduced this session, not fixed

These are the "the app doesn't work" complaints, in their measured form.

### 5.1 Runs die inside the finalize window

Observed live: a run at **192 s** against `ORCHESTRATOR_WALL_CLOCK_MS = 3 * 60_000`
(`orchestrator-budget.ts:264`) with `FINALIZE_RESERVE_MS = 90_000`
(`orchestrator-finalize.ts:43` — the finalize window therefore opens at 90 s), ending with
no durable report and `record_artifacts` never called. Invariant **I-2** then does its job — `recovery_reason` is set and the UI renders
**Interrupted** rather than a green COMPLETE — so the *labelling* is honest. The run is
still lost.

Current DB: **60 of 150 threads carry a `recovery_reason`** (40%). Some of those are the
historical ghost incident, not fresh failures; the split was not measured. Measure it
before quoting 40% as a current failure rate.

Before touching this, read `CLAUDE.md`'s run-termination section and
`INCIDENT_2026-07-26_termination-and-ghost-recovery.md` in full. The oscillation is real
and has broken production **twice, in opposite directions**:
`FORCE_TOOL_CALL_UNTIL_FINALIZE=true` removed the model's only natural exit and dropped
self-completion 61%→25%; pure `"auto"` let `"I'll now run…"` narration end a run and mark
it COMPLETE. The settled resolution is **phase-aware** (`REQUIRE_TOOL_CALL_IN_OPENING_PHASE`,
active only while the run has admitted zero tool calls and the latest user message parses
as a seed). Do not fix a termination bug by flipping a global toggle. Also settled: intent
is **not** inferred from prose — a future-intent regex was implemented and removed because
it matched the legitimate closing line *"Drop a seed and I'll run the investigation from
TRIAGE through REPORT"* and fabricated a report on top of a plain answer. And `stopWhen`
cannot prevent a natural stop; it only adds conditions. That has been tried.

### 5.2 The paid cap — settled, and NOT a bug to "fix"

`MAX_PAID_CALLS = 12` (`runtime-policy.ts:163`), alongside `MAX_TOTAL_CALLS = 30`,
`MAX_SAME_TOOL_CALLS = 16`, `MAX_CONCURRENT_CALLS = 3`, `MAX_TOOL_CALLS_PER_RUN = 36`.

It was raised to `Number.POSITIVE_INFINITY` during this session and **reverted on operator
instruction**: *"Do not set MAX_PAID_CALLS to unlimited. Keep a bounded ceiling."* The
reasoning is that the cap and the finalization state machine have to be designed
**together** — an unbounded run does not finish more often, it runs out of wall-clock
instead of budget and dies in a worse place. Also note `MAX_TOOL_CALLS_PER_RUN` was
clamped to 36 after a live run reached 230 calls / 747 s of tool time and was CPU-killed
before `onFinish`, leaving `status=active` with zero assistant messages.

The right way to reduce cap pressure is §3.7 — **stop spending the budget on quarantined
selectors** — not a higher number.

### 5.3 Canaries never run

Both were named P0 in II and both are still unrun:

- **Two-user Realtime canary.** Lovable's "critical" finding (any authed user can subscribe
  to another user's channels) was **not reproducible by inspection** — all 12 frontend
  channels use `postgres_changes` with no `broadcast`/`presence`, RLS is on for `artifacts`
  and `threads` with `auth.uid() = user_id`, and a `realtime.messages` topic policy exists.
  Inspection **cannot** prove per-subscriber enforcement. Needs two real accounts: A
  subscribes to B's thread and must receive nothing.
- **Investigation canary.** `node scripts/live-scan.mjs <domain>` after any backend deploy.

RLS on `threads`, `messages` and `artifacts` was re-confirmed today from `pg_policies` (all
three: enabled, one SELECT policy, `auth.uid() = user_id`, `relforcerowsecurity` false). That
strengthens the inspection argument but still does not replace the canary.

### 5.4 The `mcp` function's evidence contract — new, unreviewed, P1

Not a canary; a review that has never happened. §1.3 has the detail. The short form: a live
edge function returns raw `artifacts` rows over MCP, so unmasked breach values and
quarantined artifacts leave the system without passing any of the integrity layers the
frontend applies. Its authentication is sound; its evidence handling was never specified
because the function is not in this repo. Scope it as its own review before beta, and decide
deliberately whether the tool should return `select("*")` at all.

`addCorpus` — `supabase/functions/osint-agent/auto-persist-findings.ts:665–683` — keeps
only breach **corpus names** and discards the fields (passwords, DOBs, IPs) that #442/#443
now let the model see. `shapeTerminalResult` (`tools/serus_core.ts:138–161`) compounds it
by rebuilding from a fixed key list that excludes those fields.

Net effect: reveal is fixed on the **display** path and still broken on the **persistence**
path. The model prints a real value in chat; the artifact metadata does not contain it; the
report and export cannot cite it later.

Failure-first tests for this were *designed* and deliberately **not written** — the
authorization was audit-only. Persistence shape touches evidence integrity, so it needs
sign-off before code.

---

## 7. Case data — current state

Oldest **150** threads were deleted on operator instruction; **150 remain**.

```
threads 150 (0 active, 143 finished, 60 with recovery_reason)
artifacts 7102 · quarantined (subject_unlinked=true) 104 across 4 threads
evidence_log 5464 rows · newest thread 2026-08-10 16:40:37+00
```

`thread_metrics` is a **GROUP BY view, not a table** — `DELETE FROM thread_metrics` fails
with `cannot delete from view`. Omit it from cleanup scripts; it recomputes.

---

## 8. Test baselines — measured today

| Suite | Command | Result on `2ebd330` | Where measured |
| --- | --- | --- | --- |
| Frontend | `npx vitest run` | **1211 passed · 1 skipped · 102 files** (35 s local, 95 s CI) | local + CI |
| Edge | `npm run test:edge` | **1178 passed · 0 failed · 5 ignored** (48 s) | CI (see below) |
| Migrations | psql validation | pass | CI |

The edge number came from CI on `394cd0b` (= `2ebd330` plus one frontend-only test file, so
it is `main`'s baseline), because Deno is not installed in this sandbox. It moved
**1135 → 1178** since `3cac170`, consistent with the tests #442/#443 added. `CLAUDE.md`'s
754/24 is stale by two baselines.

**Using CI as the edge instrument is worth knowing about**: any PR gives you a clean
`deno test` run on a provisioned toolchain without the local install dance, and the run
that produced this number was the *failing* diagnostic PR — its Edge and Migrations jobs
both passed. A red PR is still a usable measuring device; read the per-job conclusions, not
the top-level X.

Edge-suite gotchas that have each cost a session:

- **Deno is NOT preinstalled** in the web/remote sandbox:
  `DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y`
- **`--allow-read` is mandatory.** The wiring tests read `index.ts`/`cluster.ts`/`recovery.ts`
  off disk to assert call sites exist; without it they abort with `NotCapable` before any
  assertion, which *reads exactly like a code failure and is not*.
- The old `--allow-net --no-check` form left env/sys perms off and inflated failures
  (546/57 vs 754/24 measured on the same tree).
- `deno check index.ts` has ~12–157 **pre-existing** AI-SDK/Supabase type-graph errors. Not
  a gate. Verify your change adds none.
- **"Probably environmental" is retired as an explanation.** The 24 environmental failures
  are gone. A failure is a failure.

---

## 9. Canonical fixtures

- **`leoseyes86@gmail.com`** — the collision case. Exercises the name-only quarantine
  escape, the promote leak, and the pivot storm in one run.
- **`NOC@onemobility.net`** — the *uncontaminated* budget-exhaustion case. Use this one to
  study the cap and finalization without collision noise.
- Thread **`88cf94fa-660a-43f3-bad6-81291eb18641`** — the shape behind §3.2's fixture.
- Threads **`f17ddf69`** (48 quarantined), **`1deed1c1`**, **`98da3fb9`** (24 each) — larger
  instances of the same leak; use `f17ddf69` if you want the fix stressed.

`src/dev/fixtures.json` and `src/dev/raw/` are **gitignored**. Sanitize before checking
anything in. The §3.2 test is the pattern: real ids/kinds/flags/confidence, synthetic values.

---

## 10. Seeing the signed-in workspace without prod credentials

```bash
npx vite --config vite.harness.config.ts        # → http://127.0.0.1:5174
# open /chat/11111111-2222-4333-8444-555555555555
```

Aliases `@/integrations/supabase/client` to `src/dev/supabase-mock.ts` — a chainable
PostgREST stub with fixtures for a realistic finished case (8 artifacts spanning verified →
capped → broker-only, 9 tool calls including 2 failures, a report-shaped final message).
All five tabs render. Nothing under `src/` imports the stub
(`npm run build && grep -r harness.local dist/` → nothing).

**Any promote-boundary fix must be screenshotted here before/after**, on the Graph/Clusters
tab and the Report tab specifically — those are surfaces 1 and 2 in §3.3, and a change that
correctly excludes quarantined rows should visibly reduce cluster membership. Two failure
modes have repeatedly shipped UI work that changed nothing an analyst sees: reviewing only
the signed-out surfaces, and mistaking a Vercel **preview** (`target: null`, green check,
looks identical to a real deploy) for production. Check `target`, not the checkmark.

---

## 11. Corrections — apply these to `CLAUDE.md` and handoff II

Each was verified today. Several will actively mislead a successor.

1. **`evidence-export` drift is CLOSED.** `CLAUDE.md` says the mirror runs an older
   273-line `index.ts` with no `text-sanitize.ts`. `diff -rq` across the four enumerated
   backend trees is empty today. Keep the *rule* (never blanket-overwrite; sync only changed
   files) — drop the specific claim. Note the residual gap in §1.1: source-identical ≠
   deployed.
1a. **"3 Deno edge functions" (line 3, and the `### Backend (3 edge functions)` heading) is
   wrong — there are FOUR deployed.** The fourth, `mcp`, is Lovable-generated, mirror-only,
   never in canonical history, and live. Full write-up in §1.3. Two edits follow from it:
   change the count and the list, and add the rule that **the function inventory must come
   from `ls supabase/functions/` on the MIRROR, never from this document** — a
   Vite-plugin-generated function can appear without any canonical commit, so canonical
   history cannot tell you what is deployed. Also add the corollary in §1.2: a whole-repo
   `git diff` against the mirror is meaningless (~306 files by design) and reading it as
   drift leads directly to the blanket overwrite `CLAUDE.md` forbids.
2. **`tools/peopledatalabs.ts` is no longer mirror-only**, and `tools/indicia.ts` no longer
   differs. No file is present only in the mirror. The blanket-sync hazard is still real in
   principle; both cited examples are stale.
3. **Edge baseline was 1135/0/5 on `3cac170`**, not the 754/24 still in `CLAUDE.md` and not
   1105 (that was `86f92c62`). Not re-measured today.
4. **Frontend baseline is 1211/1/102**, not II's 1200/1/101.
5. **The orchestrator is DeepSeek-pinned** (`deepseek-v4-pro`, `orchestrator_reason:
   "pinned"`) with MiniMax as fallback. `CLAUDE.md` and `AGENTS.md` both still say MiniMax
   is primary.
6. **The package manager is npm.** No `pnpm-lock.yaml`, no `test:e2e` script.
7. **`CLAUDE.md`'s "⛔ Beta blockers" section is out of date on both anchors:**
   - It says `grep -rn subject_unlinked src/` returns only `intel.ts:1129,1145`. It now
     returns `src/lib/quarantine.ts`, `src/lib/pivot-engine.ts`, and `intel.ts:6,1119,1142,
     1150,1153`. The pivot boundary is bound (#436).
   - It says three boundaries must consult it — write, pivot, promote. **Write and pivot are
     closed. Promote is open, and §3.1 shows the existing gate matches zero of the 104
     production rows.** Replace the section with a pointer to §3 here.
   - **The "name-only quarantine escape" is CLOSED — `CLAUDE.md` describes it as open and
     that is now false.** It named `auto-persist-findings.ts:826`; that line is unrelated
     today. The escape was fixed on exactly the shape `CLAUDE.md` prescribed — gate the
     exemption on *durable linkage*, never on name equality:

     ```ts
     // auto-persist-findings.ts:428 — FAILS CLOSED: absent/unusable seed ⇒ false.
     export function seedLinksQueriedName(seedName: string, queriedName: string): boolean {
       const queried = nameTokens(queriedName);
       if (queried.length < 2) return false;
       const seed = new Set(nameTokens(seedName));
       if (seed.size === 0) return false;
       return queried.every((t) => seed.has(t));      // every queried token in the SEED
     }
     // :648  queriedNameIsSubjectLinked = nameOnly && seedLinksQueriedName(subjectSeedName, queriedName)
     // :1066 if (queriedNameIsSubjectLinked) continue;   ← the only way out
     // :1067 otherwise → UNLINKED_ECHO_CTX (its own reason, not silent persistence)
     ```

     Verified end to end: `index.ts:337` derives `subjectSeedName` and threads it into both
     extraction call sites (`:1111`, `:1130`), so the gate is live in production rather than
     defaulting to `""`. An unlinked echo now gets `UNLINKED_ECHO_CTX` instead of persisting
     unquarantined at confidence 65. Replace this bullet in `CLAUDE.md` with a pointer here.
8. **II's §2 table is entirely stale** — it lists #436/#437/#438/#439 as "ALL DRAFT, none
   merged". #436, #437 and #439 are merged and live; #438's change is applied to the live
   database. Read II's §2.1 (what green CI missed) — that content is still the best thing in
   it — and ignore its status column.
9. **`REVEAL_BREACH_DATA` stays ON.** Settled operator decision, re-affirmed 2026-08-10.
   Now verifiable at `/health` (`reveal_breach_data: true`, added by #441). If an audit
   re-flags the `?? "true"` default as a safe-by-default violation, the correct response is
   one line: *settled, see handoff II §6a* — not a fresh analysis. The one real thing to
   know for release: flipping it to `false` gives **masked-by-default**, not
   click-to-reveal. No per-item reveal control exists in the UI. The release posture is a
   small feature build, not a deploy-day config change. Scope it before release.

---

## 12. Standing operating rules (unchanged, still in force)

- **Do not push directly to `main`.** Stamp commits and deploy-recipe steps are exceptions
  authorized case-by-case, not standing permission.
- **Do not deploy, publish, sync the Lovable mirror, run migrations, change secrets, alter
  auth, or modify RLS without explicit approval.**
- **Do not auto-upgrade dependencies.** Real `npm audit`: 8 vulns (5 high, 3 moderate, 0
  critical), all build/dev-only or unreachable by call-site inspection. `react-router-dom`
  `6.30.4` is the last 6.x; the only fix is a breaking major. Document and defer — do not
  "ignore" in Lovable, and state it at true strength: *no exploit path found by
  inspection*, not *proven unreachable*.
- **Never commit** real investigation subjects, email addresses, harvested PII, raw
  evidence, secrets, or production log payloads.
- **Separate, reviewable PRs.** Do not combine unrelated risk domains. The §3 work is
  minimum two PRs (clustering; then the sign-off-gated label cap) and the §3.7 work is a
  third.
- **Evidence-integrity changes need sign-off**: evidence ranking, confidence caps,
  chain-of-custody, credential masking, minor-safety detection, audit/coverage behaviour.
- **Never equate:** merged = deployed · frontend published = backend deployed · HTTP 200 =
  investigation succeeded · ignored security finding = resolved · `ok: true` = beta-ready.
- **No "green", "looks good", or "probably environmental".** Report exact results.

---

## 13. Discipline that has actually held

- **Failure-first or it does not count.** #436 was 5/8 red before the fix; #437's prompt
  tests 3/5 red; the review-driven corrections were held to the same bar. §3.2 exists as a
  committed red test for exactly this reason.
- **Unit-green is not semantics-green.** Every defect caught in review on this codebase was
  a *timeline or identity* error, not a logic error, and every one passed the full suite,
  typecheck, lint and build. #436's quarantine key was correct as a function and wrong as an
  identity. #437's gate was correct as a branch and unreachable as a state.
- **A behavioural test must DRIVE the shipped control flow, never re-describe it.** #437's
  first regression test replayed the real step sequence *through its own slightly more
  permissive copy of the branch* and passed against broken production code. If a test needs
  the branch, export the branch and call it. `decideBackstopAction` exists because of this.
- **Say things at their true strength.** "No exploit path found by inspection" ≠
  "unreachable". "Applied and verified" ≠ "self-sustaining" — the #438 revoke is not
  self-sustaining, because `pg_default_acl` for `public` functions grants `anon` EXECUTE, so
  a DROP+CREATE or a new overloaded signature silently restores it (`CREATE OR REPLACE` does
  not — probed on this database).
- **Preserve quarantined evidence; make it inert, visible, auditable.** Never delete it. The
  §3 fix must keep all 104 rows in the artifact table and in the collision section — it
  removes their *authority*, not their existence.
- **A stale scan and an ignored finding are different failures.** Two of Lovable's four
  findings were already remediated when the scan still showed them open. Check the live
  system before believing either.

---

## 14. If you have one hour, do this

1. `curl … ?health=1` and the four `diff -rq`s in §1.1. Confirm the deploy axis is still
   green before changing anything. If it moved, stop and find out why.
2. Open a PR for `diagnostic/promote-boundary-repro` with **CI IS RED ON PURPOSE** in the
   first line of the body, so the reproduction is durable and reviewable.
3. Extend that test to red on all five surfaces in §3.3.
4. Add `isClusterIneligible` and apply it at all five. Green the test. Screenshot the
   harness Graph and Report tabs before/after (§10). Draft PR, frontend-only.
5. **Separately**, write up the label-boundary cap (§3.4) as a proposal and get sign-off
   before writing a line of it.

Do **not** start with §3.7 (the dispatch guard). It is the bigger win for API spend, but it
is a backend change requiring the full stamp → sync → explicit-Lovable-deploy → moved-SHA
recipe, and it should land after the frontend boundary is closed and verified.
