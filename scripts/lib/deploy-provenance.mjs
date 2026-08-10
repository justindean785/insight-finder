/**
 * deploy-provenance.mjs — pure checks that answer one question:
 *
 *     Is the code running in production a commit I can read in this repo?
 *
 * WHY THIS EXISTS. The deploy path is insight-finder `main` → surgical sync to
 * the Lovable mirror → the Lovable project agent runs `supabase--deploy_edge_functions`.
 * Every deployed build therefore ORIGINATES as a canonical commit here — the
 * frequently-repeated claim that "the live build has no source in GitHub" is
 * false, and `git branch -r --contains <sha>` disproves it in one command.
 *
 * What was genuinely missing is different, and narrower:
 *
 *   1. NO HISTORY. `/health` reports what is live right now. Nothing recorded
 *      that a deploy happened, when, what was live before it, or whether anyone
 *      ever confirmed the SHA moved. "Was this audited against the deployed
 *      build?" had no answer a month later.
 *
 *   2. NO CROSS-CHECK. The marker is a string the deployed code reports about
 *      ITSELF. A third party runs the deploy, and has previously taken actions
 *      it was explicitly told not to take. If a file were edited between sync
 *      and deploy, `/health` would still cheerfully report the stamped SHA while
 *      the running code differed from every commit in this repo — and nothing
 *      would notice.
 *
 * These checks close both gaps. They are deliberately pure (no fetch, no git, no
 * filesystem) so the failure modes can be tested directly rather than staged
 * against a live endpoint; the I/O lives in scripts/record-deploy.mjs.
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
 *     child of the commit the marker names. History was rewritten, or the file
 *     was edited by hand. This is the check that would catch the deploying agent
 *     modifying code between the mirror sync and the deploy, which is the reason
 *     a self-reported marker cannot be trusted on its own.
 *
 * `not_on_main` is a WARNING: deploying a branch build to debug something is
 * legitimate, it is just not reviewable through merged history. Record and flag,
 * do not block.
 */
export function verifyDeployedCommit({ live, repo }) {
  const problems = [];
  const warnings = [];

  if (!repo?.exists) {
    problems.push({
      code: "unknown_commit",
      detail:
        `live build ${live.build} is not a commit in this repository — ` +
        "the deployed code cannot be reviewed here",
    });
    return { verified: false, problems, warnings };
  }

  if (!repo.stampCommit) {
    problems.push({
      code: "unstamped_marker",
      detail:
        `no commit in this repository sets BUILD_MARKER = "${live.build}" — ` +
        "the live marker was not produced by scripts/stamp-build.mjs",
    });
    return { verified: false, problems, warnings };
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

  return { verified: problems.length === 0, problems, warnings, stampCommit: repo.stampCommit };
}

/** One append-only log line. Kept flat so `jq` and `grep` both work on it. */
export function buildLogEntry({ live, verdict, recordedAt, previousBuild }) {
  return {
    recorded_at: recordedAt,
    build: live.build,
    build_committed_at: live.committedAt,
    previous_build: previousBuild ?? null,
    reveal_breach_data: live.revealBreachData,
    verified: verdict.verified,
    warnings: verdict.warnings.map((w) => w.code),
    problems: verdict.problems.map((p) => p.code),
  };
}
