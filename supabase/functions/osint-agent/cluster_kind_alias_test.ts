// cluster_kind_alias_test.ts — clustering reads the kind through lib/kind-alias.ts.
//
// `lib/cluster.ts` was the last selector keyspace the alias table had not
// reached. The write path (`artifactDedupKey`), the read path
// (`normalizeArtifactKey`) and the dispatch guard all canonicalise; clustering
// compared `a.kind` literally, so `handle` / `social` / `social_account` /
// `github_account` contributed no `handle:` token, `subdomain` no `domain:`
// token, and every row recorded under an alias spelling could only ever become
// a singleton "unattributed cluster".
//
// Measured on the 2026-09-12 `baig_azhar` export: one value carried by two
// spellings (`ip_address` from auto-persist, `ip` from record_artifacts) sat in
// two different clusters, and the report listed three "unattributed cluster"
// rows.
//
// These drive `clusterArtifacts` — the shipped entry point — rather than
// calling `strongTokens` directly, so they measure what actually clusters.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { clusterArtifacts, type Artifact } from "./lib/cluster.ts";

let seq = 0;
function art(kind: string, value: string, meta: Record<string, unknown> = {}): Artifact {
  return {
    id: `a${++seq}`,
    kind,
    value,
    source: "test_tool",
    confidence: 60,
    metaRaw: JSON.stringify({ status: "observed", ...meta }),
  } as Artifact;
}

/** Do these two artifacts end up in the same subject? */
function joined(a: Artifact, b: Artifact): boolean {
  const { members } = clusterArtifacts([a, b]);
  const [x, y] = [members.find((m) => m.id === a.id)!, members.find((m) => m.id === b.id)!];
  return x.subject_id != null && x.subject_id === y.subject_id;
}

Deno.test("every username alias spelling joins a canonical username on the same handle", () => {
  // Each of these is listed in KIND_ALIASES as `→ username`; before the fix
  // only the literal "username" produced a `handle:` token, so none of them
  // joined anything.
  for (const alias of ["handle", "social", "social_account", "github_account"]) {
    assert(
      joined(art("username", "baig_azhar"), art(alias, "baig_azhar")),
      `${alias} did not join username on an identical handle`,
    );
  }
});

Deno.test("subdomain joins domain on the same registrable root", () => {
  assert(joined(art("domain", "example.com"), art("subdomain", "mail.example.com")));
});

Deno.test("a `person` row reclassified from a username still yields its handle", () => {
  // `person → name` in the alias table; the reclassified-username branch was
  // gated on the literal kind "name", so `person` never reached it.
  assert(joined(
    art("username", "manzavisuals"),
    art("person", "ManzaVisuals", { reclassified_from: "username" }),
  ));
});

Deno.test("an IP is STILL not a strong token — canonicalising the kind must not admit one", () => {
  // Shared NAT, CGNAT and hosting make IP equality a false-link hazard, the
  // same reason names are excluded. `detectContradictions` speaks to shared
  // infrastructure instead. If this ever goes green, an identity merge is being
  // driven by an IP.
  assert(!joined(art("ip", "68.32.250.40"), art("ip_address", "68.32.250.40")));
  assert(!joined(art("ip", "68.32.250.40"), art("ip", "68.32.250.40")));
});

Deno.test("a name is STILL not a strong token (collision axis intact)", () => {
  assert(!joined(art("name", "Azhar Baig"), art("person", "Azhar Baig")));
});

Deno.test("an excluded or quarantined alias row contributes nothing", () => {
  // `isExcluded` runs before any token is emitted, and canonicalising the kind
  // must not move that ordering.
  assert(!joined(
    art("username", "baig_azhar"),
    art("handle", "baig_azhar", { subject_unlinked: true }),
  ));
  assert(!joined(
    art("username", "baig_azhar"),
    art("social_account", "baig_azhar", { excluded_collision: true }),
  ));
});

Deno.test("unrelated handles under alias spellings do NOT join", () => {
  assertEquals(joined(art("handle", "baig_azhar"), art("social", "someone_else")), false);
});
