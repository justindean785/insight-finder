#!/usr/bin/env node
/**
 * record-deploy.mjs — the post-deploy step. Proves the live edge function is a
 * commit you can read here, then writes that fact down.
 *
 *   npm run verify:deploy    # check only, prints a verdict, changes nothing
 *   npm run record:deploy    # check, then append to deploy-log.jsonl and move deploy/live
 *
 * Neither form pushes. Recording updates the local `deploy/live` ref and the log
 * file; publishing them is a deliberate `git push origin deploy/live` plus a
 * commit of the log — a deploy record is evidence, and evidence should not be
 * published by a script the moment it is generated.
 *
 * WHAT THIS IS NOT. It is not a way to "pull the deployed code back from
 * Lovable". There is nothing to pull: the deploy path runs
 * insight-finder main → mirror sync → Lovable deploy, so the deployed build
 * always originates here. What was missing is a durable record that a given
 * commit was verified live at a given time, and an independent check that the
 * marker the running code reports about itself matches the commit it names.
 *
 * Exit codes: 0 verified (warnings allowed) · 1 not verified · 2 could not reach
 * /health. A non-zero exit means DO NOT treat the deploy as audited.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHealth, verifyDeployedCommit, buildLogEntry } from "./lib/deploy-provenance.mjs";

const HEALTH_URL =
  process.env.OSINT_AGENT_HEALTH_URL ??
  "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1";
const BUILD_INFO_PATH = "supabase/functions/osint-agent/build-info.ts";
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH ?? "deploy/live";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const logPath = join(repoRoot, "deploy-log.jsonl");
const record = process.argv.includes("--record");

const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const gitOrNull = (...args) => {
  try {
    return git(...args);
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
};

const verdict = verifyDeployedCommit({ live, repo });

console.log(`live build      : ${live.build}${live.committedAt ? ` (${live.committedAt})` : ""}`);
console.log(`reveal policy   : reveal_breach_data=${live.revealBreachData}`);
console.log(`in this repo    : ${repo.exists ? "yes" : "NO"}`);
console.log(`stamp commit    : ${repo.stampCommit ? `${repo.stampCommit.slice(0, 7)} (parent ${repo.stampParent?.slice(0, 7)})` : "NOT FOUND"}`);
console.log(`reachable from main: ${repo.onMain === null ? "n/a" : repo.onMain ? "yes" : "no"}`);
for (const w of verdict.warnings) console.log(`warning [${w.code}] ${w.detail}`);
for (const p of verdict.problems) console.error(`PROBLEM [${p.code}] ${p.detail}`);
console.log(verdict.verified ? "VERIFIED — the live build is auditable from this repo" : "NOT VERIFIED");

if (!record) process.exit(verdict.verified ? 0 : 1);

if (!verdict.verified) {
  console.error("refusing to record an unverified deploy — fix the problems above first");
  process.exit(1);
}

// Previous entry, so the log reads as a sequence of transitions rather than a
// pile of snapshots ("what was live before this?" is the question you actually
// ask when something regressed).
let previousBuild = null;
if (existsSync(logPath)) {
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length) {
    try {
      previousBuild = JSON.parse(lines[lines.length - 1]).build ?? null;
    } catch {
      previousBuild = null;
    }
  }
}
if (previousBuild === live.build) {
  console.log(`already recorded: ${live.build} is the latest entry in deploy-log.jsonl — nothing to do`);
  process.exit(0);
}

const entry = buildLogEntry({
  live,
  verdict,
  recordedAt: new Date().toISOString(),
  previousBuild,
});
appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
git("branch", "--force", DEPLOY_BRANCH, live.build);

console.log(`recorded -> deploy-log.jsonl`);
console.log(`${DEPLOY_BRANCH} -> ${live.build}`);
console.log(`publish with: git push origin ${DEPLOY_BRANCH} && git add deploy-log.jsonl && git commit`);
