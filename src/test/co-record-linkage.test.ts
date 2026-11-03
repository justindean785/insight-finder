import { describe, it, expect } from "vitest";
import { buildIdentityClusters, coRecordLinks, type ReviewAdjustment } from "@/lib/intel";
import { buildEntityGraph } from "@/lib/entity-graph";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * CO_RECORD linkage — a row's metadata EXPLICITLY names another selector of the
 * case in a declared linking field (`email_associated`, `phone_associated`,
 * `linked_email`, `email_in_breach`, `phone_in_breach`, `instagram_username`,
 * `username_in_breach`), and that selector exists as its own live artifact.
 *
 * SANITIZED SYNTHETIC FIXTURE. It reproduces the SHAPE of a production person
 * case (2026-10, "76 entities · 0 real links · 12 clusters") — five breach-
 * derived usernames each carrying `email_associated = <subject email>`, a phone
 * and an Instagram account id carrying the same, a breach_exposure row naming
 * email + phone + instagram username, a VSCO profile with `linked_email`, IP
 * rows naming the email, and quarantined co-tenants. Every name, handle, email,
 * phone and IP below is invented.
 */

const SUBJECT_EMAIL = "jane.sample.q@example.com";
const SUBJECT_PHONE = "+15550104477";
const CO_TENANT_EMAIL = "other.tenant@example.net";

function mk(p: {
  id: string;
  kind: string;
  value: string;
  confidence?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}): Artifact {
  return {
    id: p.id,
    kind: p.kind,
    value: p.value,
    confidence: p.confidence ?? 55,
    source: p.source ?? "leakcheck",
    created_at: "2026-10-01T00:00:00Z",
    metadata: p.metadata ?? null,
  };
}

const QUARANTINE = { subject_unlinked: true, subject_unlinked_reason: "name_only_query" };

function fixture(): Artifact[] {
  return [
    mk({ id: "em1", kind: "email", value: SUBJECT_EMAIL, confidence: 70, source: "breach_check", metadata: { username_in_breach: "jsampleq" } }),
    mk({ id: "ph1", kind: "phone", value: SUBJECT_PHONE, confidence: 50, metadata: { email_associated: SUBJECT_EMAIL, name_in_breach: "Jane Sample" } }),
    mk({ id: "u1", kind: "username", value: "jsampleq", metadata: { email_associated: SUBJECT_EMAIL, password_in_breach: "pw-one" } }),
    mk({ id: "u2", kind: "username", value: "SampleJaneQ", metadata: { email_associated: SUBJECT_EMAIL } }),
    mk({ id: "u3", kind: "username", value: "qxxjanexx", metadata: { email_associated: SUBJECT_EMAIL, ip_in_breach: "203.0.113.7" } }),
    mk({ id: "u4", kind: "username", value: "bluewidget88", metadata: { email_associated: SUBJECT_EMAIL, phone_in_breach: "+15550109999" } }),
    mk({ id: "u5", kind: "username", value: "miss_jane_q", metadata: { email_associated: SUBJECT_EMAIL } }),
    mk({ id: "acct", kind: "account_id", value: "Instagram ID 4400112233", metadata: { email_associated: SUBJECT_EMAIL, phone_associated: SUBJECT_PHONE } }),
    mk({ id: "br1", kind: "breach_exposure", value: "ExampleBreach 2021", metadata: { email_in_breach: SUBJECT_EMAIL, phone_in_breach: SUBJECT_PHONE, instagram_username: "miss_jane_q" } }),
    mk({ id: "vsco", kind: "social_profile", value: "https://vsco.co/qxxjanexx", source: "vsco_profile", metadata: { linked_email: SUBJECT_EMAIL, platform: "vsco" } }),
    // IP rows naming the email: an IP is infrastructure and never a co-record source.
    mk({ id: "ip1", kind: "ip", value: "203.0.113.7", metadata: { email_associated: SUBJECT_EMAIL } }),
    // Quarantined co-tenants — must stay out of every link, in both directions.
    mk({ id: "qem", kind: "email", value: CO_TENANT_EMAIL, metadata: { ...QUARANTINE } }),
    mk({ id: "qu1", kind: "username", value: "tenantguy", metadata: { ...QUARANTINE, email_associated: SUBJECT_EMAIL } }),
    mk({ id: "u6", kind: "username", value: "linkstotenant", metadata: { email_associated: CO_TENANT_EMAIL } }),
    // Password-only and IP-only shared values between two unrelated handles.
    mk({ id: "pw1", kind: "username", value: "unrelatedalpha", metadata: { password_in_breach: "shared-secret" } }),
    mk({ id: "pw2", kind: "username", value: "unrelatedbravo", metadata: { password_in_breach: "shared-secret" } }),
    mk({ id: "ipa", kind: "username", value: "unrelatedcharlie", metadata: { ip_in_breach: "198.51.100.9" } }),
    mk({ id: "ipb", kind: "username", value: "unrelateddelta", metadata: { ip_in_breach: "198.51.100.9" } }),
  ];
}

const SUBJECT_IDS = ["em1", "ph1", "u1", "u2", "u3", "u4", "u5", "acct", "br1", "vsco"];
const clusterOf = (clusters: { artifacts: Artifact[] }[], id: string) =>
  clusters.findIndex((c) => c.artifacts.some((a) => a.id === id));

describe("CO_RECORD linkage — before (kill switch off reproduces today)", () => {
  it("today: the subject's selectors fragment across several clusters and the graph has 0 real links", () => {
    const arts = fixture();
    const { clusters } = buildIdentityClusters(arts, "Jane Sample sacramento california", undefined, { coRecordLinkage: false });
    const homes = new Set(SUBJECT_IDS.map((id) => clusterOf(clusters, id)).filter((i) => i >= 0));
    expect(homes.size).toBeGreaterThan(1);
    expect(clusters.flatMap((c) => c.mergeReasons).some((r) => r.startsWith("CO_RECORD"))).toBe(false);
    const g = buildEntityGraph(arts, "Jane Sample sacramento california", "person", undefined, { coRecordLinkage: false });
    expect(g.stats.realEdgeCount).toBe(0);
  });
});

describe("CO_RECORD linkage — after", () => {
  const arts = fixture();
  const report = buildIdentityClusters(arts, "Jane Sample sacramento california");

  it("groups every email-linked selector of the subject into ONE cluster", () => {
    const idx = clusterOf(report.clusters, "em1");
    expect(idx).toBeGreaterThanOrEqual(0);
    for (const id of SUBJECT_IDS) expect(clusterOf(report.clusters, id), id).toBe(idx);
  });

  it("states each merge as an auditable CO_RECORD reason naming field and source artifact id", () => {
    const c = report.clusters[clusterOf(report.clusters, "em1")];
    const co = c.mergeReasons.filter((r) => r.startsWith("CO_RECORD"));
    expect(co).toContain(`CO_RECORD: email_associated (u1 -> email ${SUBJECT_EMAIL})`);
    expect(co).toContain(`CO_RECORD: phone_associated (acct -> phone ${SUBJECT_PHONE})`);
    expect(co).toContain(`CO_RECORD: linked_email (vsco -> email ${SUBJECT_EMAIL})`);
    expect(co).toContain(`CO_RECORD: instagram_username (br1 -> username miss_jane_q)`);
    expect(co).toContain(`CO_RECORD: username_in_breach (em1 -> username jsampleq)`);
  });

  it("keeps quarantined co-tenants out in BOTH directions", () => {
    const subj = clusterOf(report.clusters, "em1");
    // quarantined rows are not cluster members at all (existing behaviour)
    expect(clusterOf(report.clusters, "qem")).toBe(-1);
    expect(clusterOf(report.clusters, "qu1")).toBe(-1);
    // a live row naming a quarantined email does not link to it, nor to the subject
    expect(clusterOf(report.clusters, "u6")).not.toBe(subj);
    const links = coRecordLinks(arts.filter((a) => !(a.metadata as Record<string, unknown> | null)?.subject_unlinked));
    expect(links.some((l) => l.sourceId === "qu1" || l.targetId === "qu1" || l.targetId === "qem")).toBe(false);
  });

  it("never links on a shared password or a shared IP", () => {
    const pw1 = clusterOf(report.clusters, "pw1");
    const pw2 = clusterOf(report.clusters, "pw2");
    if (pw1 >= 0 || pw2 >= 0) expect(pw1).not.toBe(pw2);
    const ipa = clusterOf(report.clusters, "ipa");
    const ipb = clusterOf(report.clusters, "ipb");
    if (ipa >= 0 || ipb >= 0) expect(ipa).not.toBe(ipb);
    // ip_in_breach on u3 names the ip1 artifact's value — still no link
    expect(coRecordLinks(arts).some((l) => l.targetId === "ip1" || l.sourceId === "ip1")).toBe(false);
    expect(coRecordLinks(arts).some((l) => /^(password|ip_|dob|name_in_breach)/.test(l.field))).toBe(false);
  });

  it("does not link through an analyst-rejected row", () => {
    const reviews: Record<string, ReviewAdjustment> = { u2: "dismissed" };
    const r = buildIdentityClusters(arts, null, reviews);
    expect(clusterOf(r.clusters, "u2")).toBe(-1);
    expect(r.clusters.flatMap((c) => c.mergeReasons).some((m) => m.includes("(u2 ->"))).toBe(false);
  });

  it("is grouping, not confirmation: no cluster confidence or corroboration rises, no artifact is mutated", () => {
    const snapshot = JSON.stringify(arts);
    const before = buildIdentityClusters(arts, "Jane Sample sacramento california", undefined, { coRecordLinkage: false });
    const after = buildIdentityClusters(arts, "Jane Sample sacramento california");
    const maxBefore = Math.max(...before.clusters.map((c) => c.confidence));
    const subj = after.clusters[clusterOf(after.clusters, "em1")];
    expect(subj.confidence).toBeLessThanOrEqual(maxBefore);
    // the merged cluster's confidence never exceeds the best pre-link component holding its members
    const memberHomes = new Set(subj.artifacts.map((a) => clusterOf(before.clusters, a.id)).filter((i) => i >= 0));
    const bestHome = Math.max(...Array.from(memberHomes).map((i) => before.clusters[i].confidence));
    expect(subj.confidence).toBeLessThanOrEqual(bestHome);
    expect(subj.mergeReasons.some((r) => r.startsWith("CO_RECORD"))).toBe(true);
    expect(JSON.stringify(arts)).toBe(snapshot);
    expect(arts.some((a) => (a.metadata as Record<string, unknown> | null)?.linkage_confirmed)).toBe(false);
  });

  it("does not count a CO_RECORD merge toward cluster corroboration (independent source classes)", () => {
    const before = buildIdentityClusters(arts, null, undefined, { coRecordLinkage: false });
    const after = buildIdentityClusters(arts, null);
    const subj = after.clusters[clusterOf(after.clusters, "em1")];
    expect(subj.preLinkComponents && subj.preLinkComponents.length).toBeGreaterThan(1);
    const memberIds = new Set(subj.artifacts.map((a) => a.id));
    const componentIds = new Set(subj.preLinkComponents!.flat().map((a) => a.id));
    expect(componentIds).toEqual(memberIds);
    expect(before.clusters.some((c) => c.preLinkComponents)).toBe(false);
  });
});

describe("CO_RECORD linkage — graph", () => {
  const arts = fixture();

  it("draws co-record edges between the subject's selectors (real links > 0)", () => {
    const g = buildEntityGraph(arts, "Jane Sample sacramento california", "person");
    expect(g.stats.realEdgeCount).toBeGreaterThan(0);
    const co = g.edges.filter((e) => e.type === "co-record");
    const touches = (id: string) => co.some((e) => e.source === id || e.target === id);
    for (const id of ["u1", "u2", "u3", "u4", "u5", "ph1", "acct", "vsco", "em1"]) expect(touches(id), id).toBe(true);
    expect(co.every((e) => e.reason.startsWith("CO_RECORD: "))).toBe(true);
  });

  it("keeps declared breach-record associations in the graph without making them identity edges", () => {
    const g = buildEntityGraph(arts, "Jane Sample sacramento california", "person");
    const breachLinks = g.edges.filter((e) => e.source === "br1" || e.target === "br1");
    expect(breachLinks.length).toBeGreaterThan(0);
    expect(breachLinks.every((e) => e.type === "co-record")).toBe(true);
    expect(breachLinks.map((e) => e.source === "br1" ? e.target : e.source).sort()).toEqual(["em1", "ph1", "u5"]);
  });

  it("anchors exact name-record evidence under the subject name without merging identity or changing confidence", () => {
    const named = [...arts, mk({ id: "name1", kind: "name", value: "Jane Sample", confidence: 65, source: "people_search" })];
    const baseClusters = buildIdentityClusters(arts, "Jane Sample sacramento california");
    const namedClusters = buildIdentityClusters(named, "Jane Sample sacramento california");
    const signature = (report: typeof baseClusters) => report.clusters
      .map((c) => ({ members: c.artifacts.map((a) => a.id).sort(), confidence: c.confidence, mergeReasons: c.mergeReasons }))
      .filter((c) => !c.members.includes("name1"))
      .sort((a, b) => a.members.join(",").localeCompare(b.members.join(",")));
    expect(signature(namedClusters)).toEqual(signature(baseClusters));
    const nameCluster = namedClusters.clusters.find((c) => c.artifacts.some((a) => a.id === "name1"));
    expect(nameCluster?.artifacts.map((a) => a.id)).toEqual(["name1"]);
    expect(nameCluster?.mergeReasons).toEqual([]);

    const base = buildEntityGraph(arts, "Jane Sample sacramento california", "person");
    const g = buildEntityGraph(named, "Jane Sample sacramento california", "person");
    const nameEdges = g.edges.filter((e) => e.source === "name1" || e.target === "name1");
    expect(nameEdges).toHaveLength(1);
    expect(nameEdges[0]).toMatchObject({ type: "co-record", source: "name1", target: "ph1" });
    expect(nameEdges[0].reason).toContain("NAME_RECORD: name_in_breach");
    expect(nameEdges[0].reason).toContain("not identity confirmation");
    expect(g.nodes.find((n) => n.id === "name1")?.clusterId).toBe(nameCluster?.id);
    for (const node of base.nodes) {
      expect(g.nodes.find((n) => n.id === node.id)?.confidence).toBe(node.confidence);
    }
  });

  it("requires an exact meaningful full name and respects association exclusions", () => {
    const named = [
      mk({ id: "name1", kind: "name", value: "Jane Sample" }),
      mk({ id: "single", kind: "name", value: "Jane" }),
      mk({ id: "other", kind: "name", value: "Jane Samples" }),
      mk({ id: "source", kind: "username", value: "someone", metadata: { name_in_breach: "Jane Sample" } }),
      mk({ id: "rejected", kind: "phone", value: "+15550101111", metadata: { name_in_breach: "Jane Sample" } }),
      mk({ id: "partial", kind: "email", value: "jane@example.org", metadata: { name_in_breach: "Jane" } }),
    ];
    const g = buildEntityGraph(named, null, null, { rejected: "dismissed" });
    const nameEdges = g.edges.filter((e) => e.type === "co-record" && e.reason.startsWith("NAME_RECORD"));
    expect(nameEdges.map((e) => [e.source, e.target])).toEqual([["name1", "source"]]);
    expect(g.edges.some((e) => e.source === "single" || e.target === "single" || e.source === "other" || e.target === "other")).toBe(false);
  });

  it("never draws a co-record edge to a quarantined, IP, or rejected node", () => {
    const g = buildEntityGraph(arts, null, null, { u2: "dismissed" });
    const co = g.edges.filter((e) => e.type === "co-record");
    for (const id of ["qem", "qu1", "ip1", "u2", "pw1", "pw2", "ipa", "ipb"]) {
      expect(co.some((e) => e.source === id || e.target === id), id).toBe(false);
    }
  });

  it("kill switch restores the old graph exactly", () => {
    const off = buildEntityGraph(arts, "Jane Sample sacramento california", "person", undefined, { coRecordLinkage: false });
    expect(off.edges.some((e) => e.type === "co-record")).toBe(false);
    expect(off.stats.realEdgeCount).toBe(0);
  });
});

describe("coRecordLinks — guards", () => {
  it("ignores undeclared fields even when they name an existing artifact (name, DOB, address, password)", () => {
    const arts = [
      mk({ id: "n1", kind: "name", value: "Jane Sample" }),
      mk({ id: "ad", kind: "address", value: "1 Example Way Springfield" }),
      mk({ id: "u", kind: "username", value: "someone_x", metadata: { name_in_breach: "Jane Sample", address: "1 Example Way Springfield", dob_in_breach: "1990-01-01", password_in_breach: "jsampleq" } }),
      mk({ id: "t", kind: "username", value: "jsampleq" }),
    ];
    expect(coRecordLinks(arts)).toEqual([]);
  });

  it("drops a dump row that names more than three selectors of one class", () => {
    const emails = ["a1", "a2", "a3", "a4"].map((x, i) => mk({ id: `e${i}`, kind: "email", value: `${x}.person@example.org` }));
    const dump = mk({ id: "dump", kind: "breach_exposure", value: "Combolist", metadata: { email_associated: emails.map((e) => e.value) } });
    expect(coRecordLinks([...emails, dump])).toEqual([]);
  });

  it("never links through a role mailbox", () => {
    const arts = [
      mk({ id: "e", kind: "email", value: "info@example.org" }),
      mk({ id: "u", kind: "username", value: "someone_y", metadata: { email_associated: "info@example.org" } }),
    ];
    expect(coRecordLinks(arts)).toEqual([]);
  });

  it("normalizes like the existing keys: email case, phone formatting, handle separators", () => {
    const arts = [
      mk({ id: "e", kind: "email", value: "Jane.Sample.Q@Example.com" }),
      mk({ id: "p", kind: "phone", value: "+1 (555) 010-4477" }),
      mk({ id: "h", kind: "username", value: "@Miss.Jane_Q" }),
      mk({ id: "b", kind: "breach_exposure", value: "X", metadata: { email_in_breach: "jane.sample.q@example.com", phone_in_breach: "5550104477", instagram_username: "missjaneq" } }),
    ];
    expect(coRecordLinks(arts).map((l) => `${l.sourceId}>${l.targetId}:${l.field}`)).toEqual([
      "b>e:email_in_breach",
      "b>h:instagram_username",
      "b>p:phone_in_breach",
    ]);
  });
});
