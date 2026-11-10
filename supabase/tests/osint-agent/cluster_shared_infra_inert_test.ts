// cluster_shared_infra_inert_test.ts — shared infrastructure is not identity.
//
// Measured on a live case (2026-11-08): the agent saved a site's NAMESERVERS and
// MAIL EXCHANGERS as plain `domain` rows. `strongTokens` turns every domain row into
// `domain:<label>` AND `handle:<label>`, and `collectKnownHandles` whitelists the same
// label, so:
//   - the nameserver rows (one hosting provider's `ns*` hosts) formed a "subject" of
//     their own on the provider's name, and
//   - an organisation summary that merely said "<Provider> site" joined that group by
//     the whitelisted word,
// while the organisation was NOT linked to its own domain. A hosting provider serves
// thousands of unrelated organisations; its nameservers say nothing about who owns a
// site. This is the "shared infrastructure is not identity" rule, applied at the
// matcher.
//
// Synthetic, non-sensitive fixtures only: the subject is a reserved `.test` domain and a
// made-up organisation. The provider names are generic infrastructure, not case data.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clusterArtifacts,
  clusterSharedInfraInertDisabled,
  clusterSharedInfraSelfTest,
  isClusterInert,
  isSharedInfraArtifact,
  type Artifact,
} from "../../functions/osint-agent/lib/cluster.ts";

const art = (over: Partial<Artifact>): Artifact => ({
  kind: "other", value: "x", source: "s", confidence: 50, metaRaw: "{}", ...over,
});

const ns10 = art({ kind: "domain", value: "ns10.nationbuilder.com", source: "dns_lookup", confidence: 60 });
const ns11 = art({ kind: "domain", value: "ns11.nationbuilder.com", source: "dns_lookup", confidence: 60 });
const mx = art({ kind: "domain", value: "mx1.biz.mail.yahoo.com", source: "dns_lookup", confidence: 60 });
const orgSummary = art({
  kind: "organization",
  value: "Sample Civic Org is a NationBuilder site run by a volunteer chapter",
  source: "web_read",
  confidence: 50,
});
const ownDomain = art({ kind: "domain", value: "samplecivic.test", source: "whois", confidence: 70 });
const ownWww = art({ kind: "domain", value: "www.samplecivic.test", source: "dns_lookup", confidence: 60 });

async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

Deno.test("nameserver and mail-exchanger rows of a shared provider are not cluster members", () => {
  const { members } = clusterArtifacts([ns10, ns11, mx, ownDomain]);
  for (let i = 0; i < 3; i++) {
    assertEquals(members[i].cluster_id, null, `infra row ${i} must not belong to any cluster`);
    assertEquals(members[i].subject_id, null);
  }
  assert(members[3].cluster_id !== null || members[3].subject_id === null, "the subject's own domain is unaffected");
});

Deno.test("two nameservers of one provider no longer form a subject of their own", () => {
  const { subjects } = clusterArtifacts([ns10, ns11]);
  assertEquals(subjects.length, 0, "no 'subject' may exist on a hosting provider's name");
});

Deno.test("an organisation summary that mentions the provider is not pulled into the infra group", () => {
  const { members } = clusterArtifacts([ns10, ns11, orgSummary, ownDomain, ownWww]);
  const org = members[2];
  const nsIds = [members[0].cluster_id, members[1].cluster_id];
  assert(!nsIds.includes(org.cluster_id) || org.cluster_id === null, "org summary must not share a cluster with a nameserver row");
  assertEquals(members[0].cluster_id, null);
});

Deno.test("the subject's OWN domain rows still join each other", () => {
  const { members } = clusterArtifacts([ns10, ownDomain, ownWww]);
  assert(members[1].cluster_id !== null, "own domain still clusters");
  assertEquals(members[1].cluster_id, members[2].cluster_id, "apex and www join on the domain root");
});

Deno.test("hyphenated nameserver labels of the listed providers are recognised (Route 53, Gandi, Azure DNS)", () => {
  // Codex review on #990: the provider-root check passed for these hosts but the label
  // pattern only accepted `ns\d*`, so they still created identity subjects.
  for (const host of [
    "ns-123.awsdns-45.com",
    "ns-1536.awsdns-00.org",
    "ns-100-a.gandi.net",
    "ns1-01.azure-dns.com",
    "ns2-01.azure-dns.net",
  ]) {
    const row = art({ kind: "domain", value: host, source: "dns_lookup" });
    assert(isSharedInfraArtifact(row), `${host} must be shared infrastructure`);
    assert(isClusterInert(row), host);
  }
  const { members, subjects } = clusterArtifacts([
    art({ kind: "domain", value: "ns-123.awsdns-45.com", source: "dns_lookup" }),
    art({ kind: "domain", value: "ns-456.awsdns-45.com", source: "dns_lookup" }),
    art({ kind: "domain", value: "ns-100-a.gandi.net", source: "dns_lookup" }),
    art({ kind: "domain", value: "ns-100-b.gandi.net", source: "dns_lookup" }),
  ]);
  assertEquals(subjects.length, 0, "no subject may form on a provider's hyphenated nameservers");
  for (const m of members) assertEquals(m.cluster_id, null);
});

Deno.test("hyphenated labels do not widen the rule beyond the listed providers", () => {
  // Same label shapes under the SUBJECT's own domain, or an unlisted host, stay ordinary.
  assert(!isSharedInfraArtifact(art({ kind: "domain", value: "ns-1.samplecivic.test" })));
  assert(!isSharedInfraArtifact(art({ kind: "domain", value: "ns1-01.unlisted-dns.test" })));
  // A tenant-style label that merely starts with letters of an infra word is not infra.
  assert(!isSharedInfraArtifact(art({ kind: "domain", value: "nsfw-group.gandi.net" })));
});

Deno.test("a subject-controlled nameserver or mail host is NOT shared infrastructure", () => {
  const ownNs = art({ kind: "domain", value: "ns1.samplecivic.test", source: "dns_lookup" });
  const ownMail = art({ kind: "domain", value: "mail.samplecivic.test", source: "dns_lookup" });
  assert(!isSharedInfraArtifact(ownNs), "ns1 under the subject's own registrable domain");
  assert(!isSharedInfraArtifact(ownMail), "mail.<subject domain>");
  const { members } = clusterArtifacts([ownDomain, ownNs, ownMail]);
  assert(members[0].cluster_id !== null);
  assertEquals(members[1].cluster_id, members[0].cluster_id);
  assertEquals(members[2].cluster_id, members[0].cluster_id);
});

Deno.test("a tenant subdomain on a provider is not classified as infrastructure by this rule", () => {
  // Out of scope here and recorded as such: `<tenant>.<provider>` hosts are the tenant's
  // site, not provider plumbing. They keep today's behaviour.
  const tenant = art({ kind: "domain", value: "samplecivic.nationbuilder.com", source: "web_read" });
  assert(!isSharedInfraArtifact(tenant));
  assert(!isClusterInert(tenant));
});

Deno.test("only domain-kind rows are tested: a username that spells a provider is untouched", () => {
  const u = art({ kind: "username", value: "nationbuilder", source: "username_sweep" });
  assert(!isSharedInfraArtifact(u));
  assert(!isClusterInert(u));
});

Deno.test("alias spellings of the domain kind are covered (read through kind-alias.ts)", () => {
  // `subdomain` canonicalises to `domain`; comparing the raw kind literally would let the
  // alias spelling slip past the rule, which is the gap kind-alias.ts exists to close.
  assert(isSharedInfraArtifact(art({ kind: "subdomain", value: "ns10.nationbuilder.com" })));
  assert(isClusterInert(art({ kind: "Subdomain", value: "mx1.biz.mail.yahoo.com" })));
});

Deno.test("infra rows keep their tier — inert is NOT 'Excluded'", () => {
  const { members } = clusterArtifacts([ns10]);
  assert(members[0].tier !== "Excluded", `got ${members[0].tier}`);
});

Deno.test("the kill switch restores the old grouping on the running build", async () => {
  // The case-aware label-shape rule (CLUSTER_INFRA_LABEL_SHAPE_DISABLED) also makes these
  // rows inert — it covers providers off the curated list — so legacy needs both switches.
  await withEnv("CLUSTER_SHARED_INFRA_INERT_DISABLED", "true", () => withEnv("CLUSTER_INFRA_LABEL_SHAPE_DISABLED", "true", () => {
    assert(clusterSharedInfraInertDisabled());
    assert(isSharedInfraArtifact(ns10), "the predicate stays structural; only isClusterInert honours the switch");
    assert(!isClusterInert(ns10));
    const { subjects } = clusterArtifacts([ns10, ns11]);
    assertEquals(subjects.length, 1, "legacy: the provider's name forms a subject");
  }));
  assert(!clusterSharedInfraInertDisabled(), "the switch is read at call time, not import time");
});

Deno.test("the /health self-test passes with the rule on and reports LEGACY when switched off", async () => {
  const on = clusterSharedInfraSelfTest();
  assert(on.ok, on.detail);
  assertNotEquals(on.detail.slice(0, 6), "LEGACY");
  await withEnv("CLUSTER_SHARED_INFRA_INERT_DISABLED", "true", () => {
    const off = clusterSharedInfraSelfTest();
    assert(off.ok);
    assert(off.detail.startsWith("LEGACY"));
  });
});
