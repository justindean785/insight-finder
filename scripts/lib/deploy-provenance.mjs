/**
 * deploy-provenance.mjs — pure checks establishing MARKER PROVENANCE.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT THIS PROVES                                                          │
 * │   The build marker /health reports maps to a real, reviewable position in │
 * │   this repository's history: the SHA is a commit here, some commit        │
 * │   stamped that exact marker, and that stamp commit sits as the marker's   │
 * │   child. The marker was produced by stamp-build.mjs, not invented.        │
 * │                                                                           │
 * │ WHAT THIS DOES NOT PROVE                                                  │
 * │   That the DEPLOYED BYTES are the bytes at that commit. build-info.ts is  │
 * │   a static file the running code reads and echoes. Edit system-prompt.ts  │
 * │   after the mirror sync, leave build-info.ts alone, deploy — /health      │
 * │   still reports the stamped SHA and every check below still passes.       │
 * │   An earlier version of this comment claimed otherwise. It was wrong.     │
 * │                                                                           │
 * │   Closing that gap needs a digest of the deployed ARTIFACT emitted by the │
 * │   deploying system, compared against a digest computed here. Supabase's   │
 * │   deploy API surfaces no such value through the Lovable path today, so    │
 * │   the honest move is to record the canonical source digest and label the  │
 * │   bound of the evidence — not to imply a stronger guarantee.              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The gap this DOES close is the one that actually existed: `/health` reports
 * what is live right now, and nothing recorded that a deploy happened, when,
 * what was live before it, or whether anyone confirmed the SHA moved. "Was this
 * audit run against the deployed build?" had no answer a month later.
 *
 * (On the recurring claim that a live build "has no source in GitHub":
 * `git branch -r --contains <sha>` disproves it. The pipeline runs main →
 * mirror sync → Lovable deploy; the mirror receives code, it does not author
 * it. What was missing was the record, not the source.)
 *
 * These checks are deliberately pure — no fetch, no git, no filesystem — so the
 * failure modes are tested directly rather than staged against a live endpoint.
 * The I/O lives in scripts/record-deploy.mjs.
 */

/** A SHA the marker could plausibly hold: git short-SHA, 7-40 lowercase hex. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Parse the `build` / `build_committed_at` pair out of a /health body.
 * Returns {ok:false, reason} rather than throwing — a health endpoint that is
 * down, unauthenticated, or serving an older build without these fields is an
 * expected state, not an exception.
 */
export function parseHealth(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "health body is not an object" };
  }
  const build = body.build;
  if (typeof build !== "string" || !build) {
    return { ok: false, reason: "health body has no `build` field" };
  }
  if (!SHA_RE.test(build)) {
    return { ok: false, reason: `\`build\` is not a git SHA: ${JSON.stringify(build).slice(0, 60)}` };
  }
  return {
    ok: true,
    build,
    committedAt: typeof body.build_committed_at === "string" ? body.build_committed_at : null,
    revealBreachData: typeof body.reveal_breach_data === "boolean" ? body.reveal_breach_data : null,
  };
}

/** Pull BUILD_MARKER / BUILD_COMMITTED_AT out of a build-info.ts source string. */
export function parseBuildInfo(source) {
  const marker = /export const BUILD_MARKER\s*=\s*"([^"]*)"/.exec(source ?? "");
  const committedAt = /export const BUILD_COMMITTED_AT\s*=\s*"([^"]*)"/.exec(source ?? "");
  if (!marker) return { ok: false, reason: "build-info.ts has no BUILD_MARKER" };
  return { ok: true, marker: marker[1], committedAt: committedAt ? committedAt[1] : null };
}

/**
 * Read the latest recorded marker out of raw deploy-log.jsonl text.
 *
 * THIS LIVES HERE, NOT INLINE IN record-deploy.mjs, BECAUSE OF WHAT HAPPENED WHEN
 * IT DID. The reader sat in the script where no test could reach it, and read
 * `.build` — a field buildLogEntry has never emitted; it writes `runtime_marker`.
 * Both halves shipped in the same commit, so the contract was never consistent,
 * merely unobserved: verifyLedgerConsistency stays silent when no deploy ref
 * exists, so for months the reader returned null against a populated ledger and
 * nothing said otherwise. The first checkout to fetch deploy/live got
 * "deploy-log.jsonl has no entries" about a file with two entries in it, and the
 * deploy that triggered it was fine. A gate that cries wolf gets forced past.
 *
 * The field name was the shallow half. The deeper defect: `?? null` and a
 * swallowing `catch` both collapsed "I could not read the record" into "there is
 * no record" — the same conflation record-deploy.mjs's own `previous_build_source`
 * comment warns against, committed by the code twenty lines above it. Those two
 * states demand opposite responses. An empty ledger with no ref is the legitimate
 * initial state and must proceed; an unreadable one must block, because appending
 * to a ledger you cannot read buries whatever it was trying to tell you.
 *
 * Hence a result, not a bare string: {ok, lastEntryBuild, entryCount, reason}.
 * entryCount is what makes "empty" and "unreadable" distinguishable to a caller.
 */
export function readLedger(text) {
  const lines = (text ?? "").trim().split("\n").filter(Boolean);
  if (!lines.length) return { ok: true, lastEntryBuild: null, entryCount: 0 };

  const unreadable = (reason) => ({ ok: false, reason, lastEntryBuild: null, entryCount: lines.length });

  let parsed;
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch {
    return unreadable("latest deploy-log.jsonl line is not valid JSON");
  }
  const marker = parsed?.runtime_marker;
  if (typeof marker !== "string" || !marker) {
    return unreadable("latest deploy-log.jsonl entry has no `runtime_marker`");
  }
  return { ok: true, lastEntryBuild: marker, entryCount: lines.length };
}

/**
 * The ledger and the `deploy/live` ref are two records of the same fact, written
 * by two different git operations. Nothing stops one landing without the other —
 * a commit that forgets the log, a push that forgets the ref — and a ledger that
 * can silently disagree with the ref is not evidence, it is two guesses.
 *
 * So they are checked against each other on EVERY run, before anything is
 * recorded. Divergence is a problem, not a warning: recording on top of an
 * inconsistent ledger buries the inconsistency under a newer entry.
 *
 * An empty ledger with no ref is the legitimate initial state.
 */
export function verifyLedgerConsistency({ lastEntryBuild, refBuild, unreadableReason = null }) {
  // Checked FIRST and reported under its own code. "I cannot read the ledger" is
  // not "the ledger and the ref disagree" — reporting the second when the first
  // is true sends whoever reads it to reconcile records that were never in
  // conflict, which is exactly the wrong-diagnosis loop this check caused once.
  if (unreadableReason) {
    return [{
      code: "ledger_unreadable",
      detail: `deploy-log.jsonl could not be read: ${unreadableReason} — this is NOT an empty ledger`,
    }];
  }
  if (!lastEntryBuild && !refBuild) return [];
  if (lastEntryBuild && !refBuild) {
    return [{
      code: "ledger_ref_divergence",
      detail: `deploy-log.jsonl's latest entry is ${lastEntryBuild} but the deploy ref does not exist`,
    }];
  }
  if (!lastEntryBuild && refBuild) {
    return [{
      code: "ledger_ref_divergence",
      detail: `the deploy ref points at ${refBuild} but deploy-log.jsonl has no entries`,
    }];
  }
  // The ref holds a full SHA; the ledger holds the short marker it was recorded
  // under. Compare by prefix in the direction that is actually meaningful.
  if (!refBuild.startsWith(lastEntryBuild) && !lastEntryBuild.startsWith(refBuild)) {
    return [{
      code: "ledger_ref_divergence",
      detail: `deploy ref is ${refBuild} but deploy-log.jsonl's latest entry is ${lastEntryBuild}`,
    }];
  }
  return [];
}

/**
 * The verdict.
 *
 * THE ONE-COMMIT OFFSET, which is the whole reason this is not a one-line SHA
 * comparison. `stamp-build.mjs` writes the CURRENT HEAD into build-info.ts, and
 * then that file gets committed — so the marker can never name the commit that
 * contains it. A commit's SHA is not knowable before the commit exists. The
 * shape is always:
 *
 *     markerCommit (X)  ──►  stampCommit (S, child of X)
 *     the SHA /health reports    the tree that actually deployed,
 *                                whose build-info.ts holds "X"
 *
 * The first version of this check compared /health's SHA against build-info.ts
 * AT that SHA and reported a mismatch on a perfectly good deploy, because at X
 * the file still holds the PREVIOUS marker. Verifying the pair — S's build-info
 * names X, and S's parent IS X — is both correct and strictly stronger: it pins
 * the marker to a real position in history instead of taking its word.
 *
 * Failure modes, kept distinct because they call for opposite responses:
 *
 *   unknown_commit — the reported SHA is not a commit here at all. The deploy
 *     ran from somewhere else, or the marker was hand-edited. Nothing in this
 *     repo describes what is running.
 *
 *   unstamped_marker — no commit in this repository ever carried that marker.
 *     The value was invented rather than produced by stamp-build.mjs.
 *
 *   marker_offset_mismatch — a commit carries the marker, but it is not the
 *     child of the commit the marker names. History was rewritten, or
 *     build-info.ts was edited by hand. Note the bound: this catches tampering
 *     WITH THE MARKER. It does not catch tampering with any other file, because
 *     no other file is reflected in what /health reports.
 *
 * `not_on_main` is a WARNING: deploying a branch build to debug something is
 * legitimate, it is just not reviewable through merged history. Record and flag,
 * do not block.
 */
export function verifyDeployedCommit({ live, repo, ledger }) {
  const problems = ledger ? verifyLedgerConsistency(ledger) : [];
  const warnings = [];

  if (!repo?.exists) {
    problems.push({
      code: "unknown_commit",
      detail:
        `live build ${live.build} is not a commit in this repository — ` +
        "the deployed code cannot be reviewed here",
    });
    return { markerProvenanceOk: false, problems, warnings };
  }

  if (!repo.stampCommit) {
    problems.push({
      code: "unstamped_marker",
      detail:
        `no commit in this repository sets BUILD_MARKER = "${live.build}" — ` +
        "the live marker was not produced by scripts/stamp-build.mjs",
    });
    return { markerProvenanceOk: false, problems, warnings };
  }

  const info = parseBuildInfo(repo.buildInfoSource);
  if (!info.ok) {
    problems.push({ code: "unreadable_build_info", detail: info.reason });
  } else if (info.marker !== live.build) {
    problems.push({
      code: "marker_offset_mismatch",
      detail:
        `commit ${repo.stampCommit} was expected to hold BUILD_MARKER "${live.build}" ` +
        `but holds "${info.marker}"`,
    });
  } else if (live.committedAt && info.committedAt && live.committedAt !== info.committedAt) {
    problems.push({
      code: "marker_offset_mismatch",
      detail:
        `build SHA matches but BUILD_COMMITTED_AT differs: /health says "${live.committedAt}", ` +
        `the stamp commit says "${info.committedAt}"`,
    });
  }

  if (repo.stampParent && !repo.stampParent.startsWith(live.build)) {
    problems.push({
      code: "marker_offset_mismatch",
      detail:
        `stamp commit ${repo.stampCommit} names marker ${live.build}, but its parent is ` +
        `${repo.stampParent} — the marker does not sit where stamping would have put it`,
    });
  }

  if (repo.onMain === false) {
    warnings.push({
      code: "not_on_main",
      detail: `stamp commit ${repo.stampCommit} is not reachable from main — deployed from a branch`,
    });
  }

  return { markerProvenanceOk: problems.length === 0, problems, warnings, stampCommit: repo.stampCommit };
}

/**
 * Mirror-tree comparison. Separate from marker provenance on purpose: it answers
 * a different question (does the tree we PUSHED match the tree we HOLD?) and can
 * legitimately be NOT RUN when no mirror checkout is available. Conflating "not
 * run" with "equal" is how an unverified step becomes a claimed one.
 */
export function compareSourceTrees({ canonicalTreeDigest, mirrorTreeDigest }) {
  if (!canonicalTreeDigest || !mirrorTreeDigest) return { status: "not_run", note: null };
  if (canonicalTreeDigest === mirrorTreeDigest) return { status: "equal", note: null };
  return {
    status: "differs",
    note: {
      code: "mirror_tree_differs",
      detail:
        `canonical osint-agent tree ${canonicalTreeDigest.slice(0, 12)} != ` +
        `mirror tree ${mirrorTreeDigest.slice(0, 12)} — the mirror is not carrying this build's source`,
    },
  };
}

/**
 * One append-only log line. Kept flat so `jq` and `grep` both work on it.
 *
 * EVERY FIELD IS A SEPARATE FACT, and the two that matter most are the ones that
 * are always negative today:
 *
 *   deployed_artifact_digest — null. The Lovable → Supabase deploy path exposes
 *     no digest or attestation of what was actually deployed.
 *   deployed_bytes_verified — false. Follows from the above. It is not "probably
 *     true"; it is unestablished, and a ledger that rounded it up would be
 *     asserting something nobody measured.
 *
 * A row saying only `verified: true` invites the reader to supply their own
 * definition of what was verified — which is exactly the overclaim this module
 * was corrected for. Naming each fact separately means a row read a year from now
 * cannot be mistaken for deployed-byte attestation.
 *
 * previous_build_source exists for the same reason: a bare null conflates "first
 * deploy ever recorded" with "a predecessor existed but the ledger never saw it".
 */
export function buildLogEntry({
  live,
  repo,
  verdict,
  recordedAt,
  previousBuild,
  previousBuildSource,
  mirror,
}) {
  const treeComparison = compareSourceTrees({
    canonicalTreeDigest: repo?.sourceTreeDigest ?? null,
    mirrorTreeDigest: mirror?.treeDigest ?? null,
  });
  return {
    recorded_at: recordedAt,
    // What the running function said about itself.
    runtime_marker: live.build,
    runtime_marker_committed_at: live.committedAt,
    // What this repository can show for it.
    canonical_commit: repo?.exists ? live.build : null,
    stamp_commit: repo?.stampCommit ?? null,
    stamp_parent: repo?.stampParent ?? null,
    canonical_tree_digest: repo?.sourceTreeDigest ?? null,
    // What the mirror we pushed to is carrying.
    mirror_commit: mirror?.commit ?? null,
    mirror_tree_digest: mirror?.treeDigest ?? null,
    mirror_tree_equality: treeComparison.status, // equal | differs | not_run
    // What nobody has measured.
    deployed_artifact_digest: null,
    deployed_bytes_verified: false,
    // Ledger continuity.
    previous_build: previousBuild ?? null,
    previous_build_source: previousBuildSource,
    // Observed policy, and the verdict's own bound.
    reveal_breach_data: live.revealBreachData,
    marker_provenance_ok: verdict.markerProvenanceOk,
    proves: "observed-runtime-marker-maps-to-canonical-source-history",
    warnings: verdict.warnings.map((w) => w.code),
    problems: verdict.problems.map((p) => p.code),
  };
}
