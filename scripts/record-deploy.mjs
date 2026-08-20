#!/usr/bin/env node
/**
 * record-deploy.mjs — the post-deploy step. Establishes that the live edge
 * function's build MARKER maps to a reviewable commit here, then writes that
 * down with the bound of the evidence stated in the record itself.
 *
 * READ THIS BEFORE TRUSTING THE OUTPUT. "MARKER PROVENANCE OK" is not
 * deployed-byte verification. build-info.ts is a static file the running code
 * echoes; edit any OTHER file after the mirror sync, leave the marker alone,
 * deploy, and every check here still passes. Byte-level assurance needs a
 * digest of the deployed artifact emitted by the deploying system, which the
 * Lovable → Supabase path does not currently expose. What this gives you is a
 * durable, tamper-evident record of which canonical commit each deploy claimed
 * to be — which is what was missing, and is worth having on its own.
 *
 *   npm run verify:deploy    # check only, prints a verdict, changes nothing
 *   npm run record:deploy    # check, then append to deploy-log.jsonl and move deploy/live
 *   npm run record:deploy -- --previous <sha>   # seed the predecessor explicitly
 *
 * Neither form pushes. Recording updates the local `deploy/live` ref and the log
 * file; publishing them is a deliberate `git push origin deploy/live` plus a
 * commit of the log — a deploy record is evidence, and evidence should not be
 * published by a script the moment it is generated.
 *
 * It is also not a way to "pull the deployed code back from Lovable". There is
 * nothing to pull: the pipeline runs insight-finder main → mirror sync → Lovable
 * deploy, so every deployed build originates here.
 *
 * Exit codes: 0 marker provenance ok (warnings allowed) · 1 not ok · 2 could not
 * reach /health. A non-zero exit means DO NOT treat the deploy as recorded.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseHealth,
  readLedger,
  verifyDeployedCommit,
  compareSourceTrees,
  buildLogEntry,
} from "./lib/deploy-provenance.mjs";

const HEALTH_URL =
  process.env.OSINT_AGENT_HEALTH_URL ??
  "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1";
const BUILD_INFO_PATH = "supabase/functions/osint-agent/build-info.ts";
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH ?? "deploy/live";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const logPath = join(repoRoot, "deploy-log.jsonl");
const record = process.argv.includes("--record");
const previousFlagIndex = process.argv.indexOf("--previous");
const previousOverride = previousFlagIndex >= 0 ? process.argv[previousFlagIndex + 1] : null;
const mirrorFlagIndex = process.argv.indexOf("--mirror");
const mirrorPath =
  (mirrorFlagIndex >= 0 ? process.argv[mirrorFlagIndex + 1] : null) ?? process.env.MIRROR_REPO ?? null;

const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
/**
 * Probe form. stderr is swallowed on purpose: "does deploy/live exist yet?" is
 * asked by running rev-parse and catching, and git prints "fatal: Needed a
 * single revision" to stderr on the perfectly normal first run. Letting that
 * through makes a healthy initial recording look like it errored.
 */
const gitOrNull = (...args) => {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const res = await fetch(HEALTH_URL, { headers: { accept: "application/json" } }).catch((e) => {
  console.error(`could not reach /health: ${e.message}`);
  process.exit(2);
});
const body = await res.json().catch(() => null);
const live = parseHealth(body);
if (!live.ok) {
  console.error(`unusable /health response (HTTP ${res.status}): ${live.reason}`);
  process.exit(2);
}

// Ask the repository what it knows about the SHA the deployed code named.
//
// The marker names commit X, but the file CONTAINING that marker is committed
// afterwards, in X's child S (see the offset note in deploy-provenance.mjs). So
// locate S by pickaxe — the commit that introduced this exact marker line into
// build-info.ts — and read the file at S, not at X. Reading the working-tree
// copy instead would compare the marker to itself and prove nothing.
const exists = gitOrNull("cat-file", "-e", `${live.build}^{commit}`) !== null;
const stampCommit = exists
  ? gitOrNull(
      "log", "--all", "--format=%H", "-1",
      "-S", `export const BUILD_MARKER = "${live.build}";`,
      "--", BUILD_INFO_PATH,
    ) || null
  : null;
const repo = {
  exists,
  stampCommit,
  stampParent: stampCommit ? gitOrNull("rev-parse", `${stampCommit}^`) : null,
  onMain: stampCommit
    ? gitOrNull("merge-base", "--is-ancestor", stampCommit, "origin/main") !== null
    : null,
  buildInfoSource: stampCommit ? gitOrNull("show", `${stampCommit}:${BUILD_INFO_PATH}`) : null,
  // Content digest of the canonical edge-function source at the stamp commit.
  // Recorded so a future byte-level check has something to compare against; it
  // is NOT itself evidence about the deployed artifact.
  sourceTreeDigest: stampCommit
    ? gitOrNull("rev-parse", `${stampCommit}:supabase/functions/osint-agent`)
    : null,
};

// Read the ledger BEFORE verifying: its consistency with the deploy ref is part
// of the verdict, not an afterthought. Two records of the same fact written by
// two git operations can diverge, and a ledger that can disagree with the ref is
// not evidence — it is two guesses.
// Parsing lives in readLedger (deploy-provenance.mjs) so the reader/writer
// contract is covered by the suite. It was inline here once, reading a field the
// writer never emitted, and nothing could test it — see readLedger's comment.
const ledgerRead = readLedger(existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
const lastEntryBuild = ledgerRead.lastEntryBuild;
const ledger = {
  lastEntryBuild,
  unreadableReason: ledgerRead.ok ? null : ledgerRead.reason,
  refBuild: gitOrNull("rev-parse", "--verify", `${DEPLOY_BRANCH}^{commit}`),
};

// The mirror we pushed the sync to. Comparing its osint-agent tree against the
// canonical one answers "did the sync carry this build's source?" — a different
// question from marker provenance, and one that is legitimately NOT RUN when no
// mirror checkout is at hand. Absent a path, both digests stay null and the
// comparison reports not_run rather than quietly reading as agreement.
const mirrorGit = (...args) => {
  if (!mirrorPath) return null;
  try {
    return execFileSync("git", ["-C", mirrorPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};
const mirror = {
  commit: mirrorGit("rev-parse", "--short", "HEAD"),
  treeDigest: mirrorGit("rev-parse", "HEAD:supabase/functions/osint-agent"),
};

const verdict = verifyDeployedCommit({ live, repo, ledger });
const treeComparison = compareSourceTrees({
  canonicalTreeDigest: repo.sourceTreeDigest,
  mirrorTreeDigest: mirror.treeDigest,
});

console.log(`live build       : ${live.build}${live.committedAt ? ` (${live.committedAt})` : ""}`);
console.log(`reveal policy    : reveal_breach_data=${live.revealBreachData}`);
console.log(`in this repo     : ${repo.exists ? "yes" : "NO"}`);
console.log(`stamp commit     : ${repo.stampCommit ? `${repo.stampCommit.slice(0, 7)} (parent ${repo.stampParent?.slice(0, 7)})` : "NOT FOUND"}`);
console.log(`canonical tree   : ${repo.sourceTreeDigest?.slice(0, 12) ?? "n/a"}`);
console.log(`mirror tree      : ${mirror.treeDigest?.slice(0, 12) ?? "(no mirror checkout)"} -> ${treeComparison.status}`);
console.log(`reachable from main: ${repo.onMain === null ? "n/a" : repo.onMain ? "yes" : "no"}`);
console.log(`ledger / ref     : ${ledger.lastEntryBuild ?? "(empty)"} / ${ledger.refBuild?.slice(0, 7) ?? "(no ref)"}`);
for (const w of verdict.warnings) console.log(`warning [${w.code}] ${w.detail}`);
for (const p of verdict.problems) console.error(`PROBLEM [${p.code}] ${p.detail}`);
if (treeComparison.note) console.log(`warning [${treeComparison.note.code}] ${treeComparison.note.detail}`);
console.log(
  verdict.markerProvenanceOk
    ? "VERIFIED — the observed live marker maps to canonical source history"
    : "NOT VERIFIED — marker provenance not established",
);
// Each line is a separate fact. Collapsing them into one green word is how the
// first version of this script came to claim something nobody had measured.
console.log(`  runtime marker observed          : ${live.build}`);
console.log(`  marker commit in canonical history: ${repo.exists ? "yes" : "no"}`);
console.log(`  stamp commit / parent verified   : ${verdict.markerProvenanceOk ? "yes" : "no"}`);
console.log(`  mirror tree vs canonical         : ${treeComparison.status}`);
console.log("  deployed artifact digest         : unavailable (deploy path exposes none)");
console.log("  DEPLOYED BYTES VERIFIED          : NO — unknown, and not established by this check");

if (!record) process.exit(verdict.markerProvenanceOk ? 0 : 1);

if (!verdict.markerProvenanceOk) {
  console.error("refusing to record — fix the problems above first");
  process.exit(1);
}

if (lastEntryBuild === live.build) {
  console.log(`already recorded: ${live.build} is the latest entry — nothing to do`);
  process.exit(0);
}

// Where the predecessor came from matters as much as its value. A bare null
// conflates "first deploy ever recorded" with "a predecessor existed but this
// ledger never saw it" — a distinction that matters when the log IS the evidence.
let previousBuild = lastEntryBuild;
let previousBuildSource = lastEntryBuild ? "ledger" : "unknown";
if (previousOverride) {
  previousBuild = previousOverride;
  previousBuildSource = "operator";
}

const entry = buildLogEntry({
  live,
  repo,
  verdict,
  recordedAt: new Date().toISOString(),
  previousBuild,
  previousBuildSource,
  mirror,
});

// THESE THREE WRITES ARE NOT ATOMIC. Appending the log, moving the ref, and
// committing are three separate git/fs operations; an interrupt between any two
// leaves them disagreeing. That is exactly why verifyLedgerConsistency runs
// FIRST on every invocation and blocks recording on divergence — the guarantee
// is detection on the next run, not atomicity. Do not describe it as atomic.
// Committing here (rather than leaving the log dirty) at least keeps the common
// path from routinely producing the state the check refuses to record on.
appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
git("branch", "--force", DEPLOY_BRANCH, live.build);
git("add", "deploy-log.jsonl");
git(
  "-c", "user.name=Claude", "-c", "user.email=noreply@anthropic.com",
  "commit", "-q", "-m", `chore(deploy): record live build ${live.build}`,
  "--only", "deploy-log.jsonl",
);

console.log(`recorded -> deploy-log.jsonl (committed) and ${DEPLOY_BRANCH} -> ${live.build}`);
console.log(`publish with: git push origin HEAD ${DEPLOY_BRANCH}`);
