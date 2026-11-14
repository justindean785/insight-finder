// replay/replay.ts — CLI for the L1 replay harness.
//
//   npm run replay -- src/dev/raw/replay/<case>.json
//
// Reads one snapshot (see snapshot.sql), re-runs today's deterministic engines,
// writes the full scorecard to `replay-out/<name>.scorecard.json` (gitignored) and
// prints ONLY the counts summary and the hash. No network, no database, no model.
//
// Kill switches: the engines read their CLUSTER_* switches from the environment at
// call time. Unset means the production default. To replay with a switch flipped,
// set it on the command line.
import { buildScorecard, scorecardHash } from "./scorecard.ts";
import { parseSnapshot } from "./snapshot.ts";

const REPO_ROOT = new URL("../../../../", import.meta.url);
const OUT_DIR = new URL("replay-out/", REPO_ROOT);

async function main(): Promise<number> {
  const path = Deno.args[0];
  if (!path) {
    console.error("usage: npm run replay -- <snapshot.json>");
    return 2;
  }
  const raw = JSON.parse(await Deno.readTextFile(path));
  const snapshot = parseSnapshot(raw);
  const card = buildScorecard(snapshot);
  const hash = await scorecardHash(card);

  const name = (path.split(/[\\/]/).pop() ?? "snapshot").replace(/\.json$/i, "");
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const outFile = new URL(`${name}.scorecard.json`, OUT_DIR);
  await Deno.writeTextFile(outFile, JSON.stringify({ hash, ...card }, null, 2) + "\n");

  console.log(JSON.stringify({ snapshot: name, hash, summary: card.summary }, null, 2));
  console.error(`full scorecard (local only, contains values): ${outFile.pathname}`);
  return 0;
}

if (import.meta.main) Deno.exit(await main());
