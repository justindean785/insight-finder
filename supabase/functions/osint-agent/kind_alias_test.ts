// kind_alias_test.ts — ONE alias table, honoured by every selector key.
//
// Before: aliases lived privately in dispatch-rejection.ts, so a rejected
// `ip_address` refused `ip` lookups (dispatch) while the same value persisted
// twice under both kinds (write) and a Dismiss on one twin left the other in
// the cluster (read). 2026-09-02 export: 203.0.113.x-style twin at 40 AND 70.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalKind, kindAliases } from "./lib/kind-alias.ts";
import { rejectedTypeAliases } from "./lib/dispatch-rejection.ts";
import { checkpointKey } from "./incremental-persist.ts";
import { artifactDedupKey } from "./lib/artifact-hygiene.ts";
import { dropRejectedArtifacts, normalizeArtifactKey, type ReviewLoad } from "./reviews.ts";

Deno.test("canonicalKind folds the auto-persist vocabulary onto the selector vocabulary", () => {
  assertEquals(canonicalKind("ip_address"), "ip");
  assertEquals(canonicalKind("IP_Address "), "ip");
  assertEquals(canonicalKind("social_account"), "username");
  assertEquals(canonicalKind("handle"), "username");
  assertEquals(canonicalKind("github_account"), "username");
  assertEquals(canonicalKind("subdomain"), "domain");
  assertEquals(canonicalKind("person"), "name");
  assertEquals(canonicalKind("crypto_wallet"), "wallet");
  assertEquals(canonicalKind("email"), "email");
  assertEquals(canonicalKind(""), "");
});

Deno.test("social_profile folds onto url ONLY when the value is URL-shaped", () => {
  assertEquals(canonicalKind("social_profile", "https://social.example/qa"), "url");
  assertEquals(canonicalKind("social_profile", "qa_nightjar"), "social_profile");
  assertEquals(kindAliases("social_profile", "https://x.example/a"), ["social_profile", "url"]);
});

Deno.test("dispatch-rejection keys through the shared table", () => {
  assertEquals(rejectedTypeAliases("ip_address"), ["ip_address", "ip"]);
  assertEquals(rejectedTypeAliases("social_account"), ["social_account", "username"]);
  assertEquals(rejectedTypeAliases("email"), ["email"]);
});

Deno.test("checkpointKey: ip_address and ip for one value are ONE key", () => {
  assertEquals(checkpointKey("ip_address", "203.0.113.57"), checkpointKey("ip", "203.0.113.57"));
  assert(checkpointKey("ip", "203.0.113.57") !== checkpointKey("ip", "203.0.113.58"));
});

Deno.test("artifactDedupKey: kind is canonical, the VALUE stays whole and case-sensitive", () => {
  assertEquals(
    artifactDedupKey({ kind: "ip_address", value: "203.0.113.57", source: "oathnet" }),
    artifactDedupKey({ kind: "ip", value: "203.0.113.57", source: "OATHNET" }),
  );
  assert(artifactDedupKey({ kind: "url", value: "https://a.example/X" }) !== artifactDedupKey({ kind: "url", value: "https://a.example/x" }));
  assert(artifactDedupKey({ kind: "other", value: "violations_total 670" }) !== artifactDedupKey({ kind: "other", value: "violations_total 676" }));
});

Deno.test("⛔ a Dismiss on the ip_address twin drops the ip twin from every read", () => {
  assertEquals(normalizeArtifactKey("ip_address", "203.0.113.57"), normalizeArtifactKey("IP", " 203.0.113.57 "));
  const review: ReviewLoad = {
    ok: true,
    byId: new Map([["twin-a", "dismissed"]]),
    noteById: new Map(),
    rejectedKeys: new Set([normalizeArtifactKey("ip_address", "203.0.113.57")]),
    rejectedRows: [{ id: "twin-a", kind: "ip_address", value: "203.0.113.57" }],
    reviewedRows: [],
    error: null,
  };
  const rows = [
    { id: "twin-a", kind: "ip_address", value: "203.0.113.57" },
    { id: "twin-b", kind: "ip", value: "203.0.113.57" },
    { id: "other", kind: "ip", value: "203.0.113.58" },
  ];
  assertEquals(dropRejectedArtifacts(rows, review).map((r) => r.id), ["other"]);
});
