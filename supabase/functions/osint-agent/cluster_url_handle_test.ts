// cluster_url_handle_test.ts — a URL artifact must join its subject on the
// handle in its PATH, not only when its metadata happens to carry a `handle` key.
//
// Every case below is shaped from production thread 202d2756 (@wopdell,
// 2026-09-13), where 46 of 55 graph entities were isolated leads. These tests DRIVE
// `clusterArtifacts` — the shipped control flow — rather than re-describing it.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { clusterArtifacts, type Artifact } from "./lib/cluster.ts";

function art(kind: string, value: string, meta: Record<string, unknown> = {}, confidence = 55): Artifact {
  return { id: crypto.randomUUID(), kind, value, source: "test", confidence, metaRaw: JSON.stringify(meta) };
}

/** The seed handle, the only thing that makes a path segment a known handle. */
const SEED = () => art("username", "wopdell", {}, 50);

function subjectOf(arts: Artifact[], value: string) {
  const { subjects } = clusterArtifacts(arts);
  return subjects.find((s) => s.members.some((m) => m.value === value));
}

function sameSubject(arts: Artifact[], a: string, b: string): boolean {
  const sa = subjectOf(arts, a), sb = subjectOf(arts, b);
  return !!sa && !!sb && sa.subjectId === sb.subjectId;
}

Deno.test("URL handle: a path-segment handle joins the subject with NO metadata.handle", () => {
  // The exact production regression: beatport carried no `handle` key and became a
  // singleton while audiomack, same artist and same spelling, joined.
  const beatport = "https://www.beatport.com/artist/wop-dell/1461425";
  const arts = [SEED(), art("social_profile", beatport, { platform: "Beatport" })];
  assert(sameSubject(arts, "wopdell", beatport), "beatport must join the wopdell subject");
});

Deno.test("URL handle: the metadata.handle path still joins (no regression)", () => {
  const audiomack = "https://audiomack.com/wop-dell";
  const arts = [SEED(), art("social_profile", audiomack, { handle: "@wop-dell" })];
  assert(sameSubject(arts, "wopdell", audiomack), "the pre-existing metadata.handle join must survive");
});

Deno.test("URL handle: the artifacts that starve the corroboration bar all join one subject", () => {
  // These five were five separate singletons in production, so no cluster ever
  // reached finding-synthesis's >=2-independent-source-class bar.
  const urls = [
    "https://soundcloud.com/wopdell",
    "https://music.apple.com/us/artist/wop-dell/1575104299",
    "https://music.apple.com/us/artist/wopdell/1577345663",
    "https://trapaganda.com/artist/wopdell",
    "https://t.me/thewopniqqa",
  ];
  const arts = [SEED(), art("username", "thewopniqqa", {}, 50), ...urls.map((u) => art("social_profile", u))];
  const { subjects } = clusterArtifacts(arts);
  const singletons = subjects.filter((s) => s.members.length === 1);
  assertEquals(singletons.length, 0, `expected no isolated leads, got ${singletons.map((s) => s.members[0].value)}`);
  for (const u of urls.slice(0, 4)) assert(sameSubject(arts, "wopdell", u), `${u} must join wopdell`);
});

Deno.test("URL handle: a shared STRUCTURAL segment never links two strangers", () => {
  // Both URLs contain "/artist/"; neither handle is known. A shared path *shape*
  // must not merge two different people — that is the Hamza Shakoor failure.
  const a = "https://www.beatport.com/artist/some-other-act/99";
  const b = "https://music.apple.com/us/artist/a-third-act/1234567";
  const arts = [SEED(), art("social_profile", a), art("social_profile", b)];
  assert(!sameSubject(arts, a, b), "unrelated artists must not merge on a shared path segment");
  assert(!sameSubject(arts, "wopdell", a), "an unrelated artist must not join the seed subject");
});

Deno.test("URL handle: numeric ids and opaque slugs link nothing", () => {
  const a = "https://www.instagram.com/p/CqvoyeZJP_F/";
  const b = "https://www.instagram.com/reel/CqvoyeZJP_F/";
  // Same opaque id in both, but an id is not a known handle, so no join is earned.
  const arts = [SEED(), art("social_profile", a), art("social_profile", b)];
  assert(!sameSubject(arts, a, b), "an opaque post id must not act as a handle");
});

Deno.test("URL handle: an excluded_collision row still cannot bridge via its URL", () => {
  const collision = "https://www.beatport.com/artist/wop-dell/1461425";
  const arts = [
    SEED(),
    art("excluded_collision", collision, { excluded_collision: true, status: "excluded" }, 15),
  ];
  const s = subjectOf(arts, collision);
  assertEquals(s, undefined, "an excluded row must never enter a subject, URL handle or not");
});

Deno.test("URL handle: CLUSTER_URL_HANDLE_TOKENS_DISABLED=true restores the old behaviour", () => {
  const beatport = "https://www.beatport.com/artist/wop-dell/1461425";
  const arts = [SEED(), art("social_profile", beatport, { platform: "Beatport" })];
  Deno.env.set("CLUSTER_URL_HANDLE_TOKENS_DISABLED", "true");
  try {
    assert(!sameSubject(arts, "wopdell", beatport), "kill switch must return beatport to a singleton");
  } finally {
    Deno.env.delete("CLUSTER_URL_HANDLE_TOKENS_DISABLED");
  }
  assert(sameSubject(arts, "wopdell", beatport), "and the join must come back when the switch is cleared");
});
