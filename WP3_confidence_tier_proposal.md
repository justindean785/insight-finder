# WP3 — Confidence/Tier hardening (PROPOSE-ONLY — NOT APPLIED)

> **Status: proposal only.** No file below is modified on this branch. `lib/cluster.ts`
> (C-1 union-find) and `confidence.ts` (C-2 caps) are unchanged. This document shows
> the current merge/tier logic and a reviewable diff. **You decide whether to apply it.**

## Goal (from the task)

> Change it so **exact-handle-string match alone cannot yield a Confirmed identity tier** —
> require at least one *behavioral* signal (shared bio text, shared external link, avatar
> reuse) to exceed a low cap.

## Where the tier is decided today (grounded in live code)

Backend deterministic clustering promotes a member's confidence in
`supabase/functions/osint-agent/lib/cluster.ts`:

```ts
// lib/cluster.ts:26 — tier bands
export const TIERS = { CONFIRMED: 90, LIKELY: 75, POSSIBLE: 50, WEAK: 30 } as const;

// lib/cluster.ts:203 — a username artifact contributes a bare handle token
if (a.kind === "username") t.add(`handle:${foldHandle(a.value)}`);

// lib/cluster.ts:255-278 — the promotion rubric
export function promoteConfidence(
  member: Artifact,
  clusterMembers: Artifact[],
  opts: { contradicted: boolean; hasSelfAdmission: boolean },
): number {
  if (isExcluded(member)) return member.confidence;
  if (opts.contradicted) return Math.min(member.confidence, 40);
  let conf = member.confidence;
  // ≥2 distinct sources → lift toward Likely, capped by the member's own confidence.
  if (distinctSources(clusterMembers).size >= 2) conf = Math.max(conf, Math.min(TIERS.LIKELY, member.confidence));
  // The ONE promotion above the cap: a PROVEN first-party self-admission.
  if (opts.hasSelfAdmission && isVerifiedSelfAdmission(member)) conf = Math.max(conf, TIERS.CONFIRMED);
  return conf;
}
```

**What this already protects, and the residual gap.** A cluster joined only by identical
`handle:` tokens cannot today reach `CONFIRMED` (90) — that requires a *verified
self-admission* (which contributes `quote:`/`own:` tokens, so such a cluster is not
"handle-only"). The frontend mirror caps a handle-only display cluster at 60
(`HANDLE_ONLY_CLUSTER_CAP`, `src/lib/intel.ts`). **However**, the `≥2 distinct sources`
rule can still lift a purely handle-joined cluster to **`LIKELY` (75)** with *no behavioral
corroboration at all* — 21 platforms all answering "the string `pjsmakka` exists here" is
21 handle-existence hits, not evidence they are the same person. The proposal makes the
"needs a behavioral signal" rule **explicit and enforced**, and lowers the handle-only
ceiling from Likely (75) to Possible (50).

## Definition — "behavioral signal"

A cluster has a behavioral signal when its members share something a *namesake could not
trivially reproduce*:
- a **concrete cross-selector** already in the token set — `email:` / `phone:` /
  `address:` / `acct:` / `domain:` (these are non-handle strong tokens), **or**
- a **shared external link** (identical `externalUrl` / `bioLinks` across members), **or**
- **avatar reuse** (identical `avatar_sha` / image hash across members), **or**
- a **shared distinctive bio phrase** (identical non-generic bio string across members).

A cluster whose *only* join evidence is `handle:` tokens and which has none of the above is
**handle-only** and is capped at `POSSIBLE` (50).

## Proposed diff (UNAPPLIED)

```diff
--- a/supabase/functions/osint-agent/lib/cluster.ts
+++ b/supabase/functions/osint-agent/lib/cluster.ts
@@
 // ---- Confidence tiers (JD's schema) -------------------------------------------
 export const TIERS = { CONFIRMED: 90, LIKELY: 75, POSSIBLE: 50, WEAK: 30 } as const;
+
+// WP3: a cluster joined ONLY by identical handle strings (no concrete cross-selector
+// and no behavioral signal) is capped here. An identical handle proves the STRING is
+// taken on N sites, never that they are the same PERSON — so it may not exceed Possible.
+export const HANDLE_ONLY_TIER_CAP = TIERS.POSSIBLE; // 50
+
+/** A behavioral signal is something a namesake could not trivially reproduce: a
+ *  concrete cross-selector (email/phone/address/acct/domain), a shared external link,
+ *  avatar reuse, or an identical distinctive bio phrase. Returns true if the cluster
+ *  is joined/corroborated by any of these — i.e. it may exceed the handle-only cap. */
+export function clusterHasBehavioralSignal(selectors: string[], clusterArts: Artifact[]): boolean {
+  // 1. A non-handle strong token means the union already rests on a concrete selector.
+  if (selectors.some((s) => !s.startsWith("handle:"))) return true;
+  // 2. A behavioral attribute shared across ≥2 members.
+  const seen = { link: new Set<string>(), avatar: new Set<string>(), bio: new Set<string>() };
+  const hit = { link: false, avatar: false, bio: false };
+  for (const a of clusterArts) {
+    for (const k of ["external_url", "externalUrl", "bio_link", "bioLinks"]) {
+      const v = metaStr(a.metaRaw, k); if (!v) continue;
+      const f = v.toLowerCase().trim(); if (seen.link.has(f)) hit.link = true; else seen.link.add(f);
+    }
+    for (const k of ["avatar_sha", "avatar_hash", "image_sha256"]) {
+      const v = metaStr(a.metaRaw, k); if (!v) continue;
+      if (seen.avatar.has(v)) hit.avatar = true; else seen.avatar.add(v);
+    }
+    const bio = metaStr(a.metaRaw, "bio");
+    if (bio && bio.trim().length >= 12) { const f = bio.toLowerCase().trim(); if (seen.bio.has(f)) hit.bio = true; else seen.bio.add(f); }
+  }
+  return hit.link || hit.avatar || hit.bio;
+}
@@ export function promoteConfidence(
   member: Artifact,
   clusterMembers: Artifact[],
-  opts: { contradicted: boolean; hasSelfAdmission: boolean },
+  opts: { contradicted: boolean; hasSelfAdmission: boolean; handleOnly?: boolean },
 ): number {
   if (isExcluded(member)) return member.confidence; // untouched
   if (opts.contradicted) return Math.min(member.confidence, 40); // do NOT promote
   let conf = member.confidence;
   if (distinctSources(clusterMembers).size >= 2) conf = Math.max(conf, Math.min(TIERS.LIKELY, member.confidence));
+  // WP3: a handle-only cluster (no behavioral signal) may not exceed Possible — an
+  // identical handle string across sites is not evidence of one person. A cluster
+  // WITH a behavioral signal (or a self-admission below) is exempt.
+  if (opts.handleOnly) conf = Math.min(conf, HANDLE_ONLY_TIER_CAP);
   if (opts.hasSelfAdmission && isVerifiedSelfAdmission(member)) conf = Math.max(conf, TIERS.CONFIRMED);
   return conf;
 }
@@ export function clusterArtifacts(arts: Artifact[]): ClusterResult {
   for (const [root, idxs] of byRoot) {
     const selectors = [...new Set(idxs.flatMap((i) => tokensPer[i]))].sort();
     const hash = stableHash(selectors.join("|") || `root${root}`);
     const subjectId = `subj_${hash}`, clusterId = `clus_${hash}`;
     const clusterArts = idxs.map((i) => arts[i]);
     const isContra = idxs.some((i) => memberContradicted[i]);
     const hasSelfAdmission = idxs.some((i) => isVerifiedSelfAdmission(arts[i]));
+    // WP3: handle-only join gate. A multi-member cluster whose union rests solely on
+    // identical handle strings, with no behavioral signal, is capped at Possible.
+    const handleOnly = idxs.length > 1
+      && selectors.length > 0
+      && !clusterHasBehavioralSignal(selectors, clusterArts);
     const clusterMembers: ClusterMember[] = [];
     for (const i of idxs) {
-      const conf = promoteConfidence(arts[i], clusterArts, { contradicted: isContra, hasSelfAdmission });
+      const conf = promoteConfidence(arts[i], clusterArts, { contradicted: isContra, hasSelfAdmission, handleOnly });
```

## Behavior change (before → after)

| Cluster | Today | With proposal |
|---|---|---|
| 21 platforms, same handle `pjsmakka`, no shared bio/link/avatar | up to **Likely (75)** | **Possible (50)** — capped |
| Same handle **+** identical external link across 2 profiles | Likely (75) | Likely (75) — behavioral signal present, exempt |
| Same handle **+** shared email/phone (concrete selector) | Likely+ | unchanged — non-handle token present |
| Verified self-admission ("= SAME PERSON") | Confirmed (90) | Confirmed (90) — unchanged (self-admission is not handle-only) |

## Risks / notes
- Reads new metadata keys (`external_url`/`externalUrl`, `bioLinks`, `avatar_sha`, `bio`).
  Where those aren't populated, a handle-only cluster is (correctly) capped — conservative.
- Purely additive to the promotion rubric; does **not** rewrite the union-find or the C-2
  caps in place, and never *raises* any tier.
- Suggest a companion `lib/cluster_test.ts` case: a 3-platform same-handle cluster with no
  behavioral signal asserts `tier === "Possible"`; the same cluster + a shared `externalUrl`
  asserts it may reach `Likely`.
- Frontend `HANDLE_ONLY_CLUSTER_CAP` (60) already caps the *display* cluster; this aligns
  the authoritative backend promotion with an even more conservative 50 and makes the rule
  explicit rather than emergent.
```
