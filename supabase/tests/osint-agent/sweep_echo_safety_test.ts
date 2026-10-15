// sweep_echo_safety_test.ts — a platform that echoes the requested handle on its
// NOT-FOUND page must never score as a proven registration.
//
// Measured 2026-09-13 by replaying sweeper.ts's own decision chain against two
// different guaranteed-nonexistent handles: six sites answered 2xx AND echoed the
// handle into a high-signal region, so `bodyEvidencesAccount` proved a
// registration for a username that cannot exist. HackerRank was the worst of
// them — 309 artifacts across 114 threads in production, marked false by the
// analyst repeatedly, with no mechanism able to act on that.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { accountIsProven } from "../../functions/osint-agent/sweeper.ts";

const HANDLE = "zzq7x4nonexistent99aab";
/** The shape that caused the false positive: a not-found page that titles the
 *  requested handle. `highSignalRegions` reads <title>, og: meta and canonical,
 *  so this is exactly what fooled the echo test in production. */
const ECHOING_NOT_FOUND = `<html><head><title>${HANDLE} | Example</title></head><body>Page not found</body></html>`;

Deno.test("echoUnsafe: a handle-echoing not-found page is NOT proof of registration", () => {
  assertEquals(accountIsProven({ echoUnsafe: true }, ECHOING_NOT_FOUND, HANDLE), false);
});

Deno.test("echoUnsafe: the SAME body still proves an ordinary site — the change is narrow", () => {
  // If this ever fails, the fix stopped being a per-platform correction and
  // started disabling echo proof everywhere.
  assertEquals(accountIsProven({}, ECHOING_NOT_FOUND, HANDLE), true);
});

Deno.test("echoUnsafe: a measured `confirm` marker still promotes the site back to provable", () => {
  const site = { confirm: "data-profile-id=", echoUnsafe: true } as const;
  assertEquals(accountIsProven(site, `<div data-profile-id="42">`, HANDLE), true);
  assertEquals(accountIsProven(site, ECHOING_NOT_FOUND, HANDLE), false);
});

Deno.test("echoUnsafe: no body can prove an unmarked echoUnsafe site", () => {
  for (const body of [ECHOING_NOT_FOUND, `<title>${HANDLE}</title>`, HANDLE, "", "<html></html>"]) {
    assertEquals(accountIsProven({ echoUnsafe: true }, body, HANDLE), false);
  }
});

// ---- the shipped table, asserted at source level ---------------------------
// A mark silently dropped here is a production false positive coming back, and
// nothing else in the suite would notice.
const SRC = Deno.readTextFileSync(new URL("../../functions/osint-agent/sweeper.ts", import.meta.url));
/** Measured FOUND for a handle that cannot exist. HackerRank, Mixcloud, Spotify,
 *  Telegram and Trakt reproduced on both probe runs; NameMC was conclusive once
 *  and errored (no signal) on the second, so it is marked on one measurement. */
const MEASURED_UNSAFE = ["HackerRank", "Minecraft (NameMC)", "Mixcloud", "Spotify", "Telegram", "Trakt"];

Deno.test("echoUnsafe: every measured platform is marked in the shipped site table", () => {
  for (const name of MEASURED_UNSAFE) {
    const row = SRC.split("\n").find((l) => l.includes(`name: "${name}"`));
    assert(row, `site "${name}" is missing from the table`);
    assert(row!.includes("echoUnsafe: true"), `site "${name}" lost its echoUnsafe mark`);
  }
});

Deno.test("echoUnsafe: no site is marked that was not measured", () => {
  const marked = SRC.split("\n")
    .filter((l) => l.includes("echoUnsafe: true") && l.includes("name: \""))
    .map((l) => /name:\s*"([^"]+)"/.exec(l)?.[1] ?? "")
    .sort();
  assertEquals(marked, [...MEASURED_UNSAFE].sort());
});

// ---- the instrument that found this, kept runnable -------------------------
// Skipped by default: it makes ~99 live requests, takes ~70s, and depends on
// third-party uptime, so in CI it would be a flake generator rather than a gate.
// It is the measurement this whole file rests on, so it ships runnable rather
// than as a comment. Run it whenever the site table changes:
//
//   SWEEP_LIVE_PROBE=1 deno test --no-check --allow-net --allow-env --allow-read \
//     --filter "live probe" sweep_echo_safety_test.ts
//
// Verified against this commit: 6 offenders before the fix, 0 after.
Deno.test({
  name: "echoUnsafe: live probe — no site proves a guaranteed-nonexistent handle",
  ignore: Deno.env.get("SWEEP_LIVE_PROBE") !== "1",
  async fn() {
    const garbage = `qq${Math.random().toString(36).slice(2, 12)}zz`;
    const block = SRC.slice(SRC.indexOf("const sites: SweepSite[] = ["));
    const re = /\{\s*name:\s*"([^"]+)",\s*url:\s*`([^`]+)`(?:,\s*absent:\s*(?:(\d+)|"([^"]*)"))?(?:,\s*echoUnsafe:\s*true)?\s*\}/g;
    const offenders: string[] = [];
    for (const m of block.matchAll(re)) {
      const [, name, rawUrl, aNum, aStr] = m;
      const unsafe = m[0].includes("echoUnsafe");
      try {
        const r = await fetch(rawUrl.replace(/\$\{u\}/g, garbage), { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
        if (aNum && r.status === Number(aNum)) continue;
        if (r.status === 404 || r.status === 410 || r.status >= 400) continue;
        const body = await r.text();
        if (aStr && body.includes(aStr)) continue;
        if (accountIsProven(unsafe ? { echoUnsafe: true } : {}, body, garbage)) offenders.push(name);
      } catch { /* unreachable platform proves nothing either way */ }
    }
    assertEquals(offenders, [], `these platforms proved a nonexistent handle: ${offenders.join(", ")}`);
  },
});
