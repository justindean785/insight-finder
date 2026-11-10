// seed_dotted_handle_test.ts — a dotted handle is a username seed, not a domain (edge half).
//
// Measured on a production case (2026-11-10): the analyst typed a handle shaped like `name.suffix` whose suffix is
// not a TLD. detectSeedServer typed it `domain` (DOMAIN was tested before USER), the thread was titled "Domain: …",
// the domain tools had nothing to resolve, and the agent swept the SHORTENED handle — a common one owned by other
// people. 41 findings, 0 linked to the seed. The client mirror is src/lib/seed.ts. Values here are synthetic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectSeedServer, formatThreadTitle, seedDottedHandleSelfTest } from "../../functions/osint-agent/validation.ts";
import { endsInKnownTld, IANA_TLDS, isKnownTld, RESERVED_TLDS } from "../../functions/osint-agent/lib/tld-list.ts";

/** MUST match DOTTED_SEED_TABLE in src/test/seed-dotted-handle.test.ts. */
const DOTTED_SEED_TABLE: Array<[input: string, kind: string, normalized: string]> = [
  ["sample.handle", "username", "sample.handle"],
  ["Sample.Handle", "username", "sample.handle"],
  ["first.last.priv", "username", "first.last.priv"],
  ["sample_one.x1", "username", "sample_one.x1"],
  ["@sample.handle", "username", "sample.handle"],
  ["example.com", "domain", "example.com"],
  ["sub.example.co.uk", "domain", "sub.example.co.uk"],
  ["sample.dev", "domain", "sample.dev"],
  ["example.invalid", "domain", "example.invalid"],
  ["host.internal", "domain", "host.internal"],
  ["xn--e1afmkfd.xn--p1ai", "domain", "xn--e1afmkfd.xn--p1ai"],
  ["203.0.113.57", "ip", "203.0.113.57"],
  ["report.pdf", "domain", "report.pdf"],
  ["sample_handle", "username", "sample_handle"],
];

Deno.test("a dotted token is a domain only when its last label is a TLD; otherwise a username with the full value", () => {
  for (const [input, kind, normalized] of DOTTED_SEED_TABLE) {
    const d = detectSeedServer(input);
    assertEquals(d?.kind, kind, input);
    assertEquals(d?.normalized, normalized, input);
  }
});

Deno.test("the full dotted value is the handle: nothing is cut off", () => {
  assertEquals(detectSeedServer("sample.handle"), { kind: "username", raw: "sample.handle", normalized: "sample.handle" });
});

Deno.test("the thread title labels it a username, and a real domain still a domain", () => {
  assertEquals(formatThreadTitle("sample.handle"), "Username: sample.handle");
  assertEquals(formatThreadTitle("example.com"), "Domain: example.com");
});

Deno.test("a dotted token too long to be a handle is `other`, never a domain", () => {
  assertEquals(detectSeedServer(`${"a".repeat(41)}.handle`)?.kind, "other");
});

Deno.test("the TLD list is the IANA root zone plus the reserved names", () => {
  assert(IANA_TLDS.size > 1400, `only ${IANA_TLDS.size} TLDs`);
  for (const t of ["com", "org", "dev", "zip", "uk", "xn--p1ai", "example", "invalid", "test", "onion"]) assert(isKnownTld(t), t);
  for (const t of ["handle", "priv", "pvt", "official", "x1", ""]) assert(!isKnownTld(t), t);
  assert(!endsInKnownTld("no-dot"));
  assert(RESERVED_TLDS.has("localhost"));
});

Deno.test("PARITY (source assertion): the edge TLD list and the client's are the same list", async () => {
  const listOf = (src: string) => {
    const text = /const IANA_TLD_TEXT = `([^`]*)`/.exec(src)?.[1] ?? "";
    const reserved = /RESERVED_TLDS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? "";
    return { tlds: text.split(/\s+/).filter(Boolean), reserved: reserved.replace(/\s+/g, "") };
  };
  const edge = listOf(await Deno.readTextFile(new URL("../../functions/osint-agent/lib/tld-list.ts", import.meta.url)));
  const client = listOf(await Deno.readTextFile(new URL("../../../src/lib/tld-list.ts", import.meta.url)));
  assert(edge.tlds.length > 1400, "edge list parsed");
  assertEquals(edge.tlds, client.tlds);
  assertEquals(edge.reserved, client.reserved);
});

Deno.test("PARITY (source assertion): the client applies the same rule, and the same file-name exception", async () => {
  const client = await Deno.readTextFile(new URL("../../../src/lib/seed.ts", import.meta.url));
  assert(client.includes("DOMAIN_RE.test(raw) && (endsInKnownTld(raw) || endsInDocumentExtension(raw))"), "client rule");
  const server = await Deno.readTextFile(new URL("../../functions/osint-agent/validation.ts", import.meta.url));
  const exts = (src: string) => (/DOCUMENT_EXTENSIONS = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? "").replace(/\s+/g, "");
  assert(exts(server).length > 50, "server extensions parsed");
  assertEquals(exts(server), exts(client));
});

Deno.test("the /health self-test engages and reports ok", () => {
  const t = seedDottedHandleSelfTest();
  assert(t.ok, t.detail);
  assert(t.enabled);
  assertEquals(t.switch, "SEED_DOTTED_HANDLE_DISABLED=false");
});

Deno.test("kill switch SEED_DOTTED_HANDLE_DISABLED=true restores the old classification (read at call time) and /health reports LEGACY", () => {
  const prior = Deno.env.get("SEED_DOTTED_HANDLE_DISABLED");
  try {
    Deno.env.set("SEED_DOTTED_HANDLE_DISABLED", "true");
    assertEquals(detectSeedServer("sample.handle")?.kind, "domain", "old behaviour: every dotted token was a domain");
    assertEquals(detectSeedServer("example.com")?.kind, "domain");
    const t = seedDottedHandleSelfTest();
    assert(t.ok);
    assert(!t.enabled);
    assert(t.detail.startsWith("LEGACY"), t.detail);
    Deno.env.set("SEED_DOTTED_HANDLE_DISABLED", "false");
    assertEquals(detectSeedServer("sample.handle")?.kind, "username", "only the exact string 'true' throws the switch");
  } finally {
    if (prior === undefined) Deno.env.delete("SEED_DOTTED_HANDLE_DISABLED"); else Deno.env.set("SEED_DOTTED_HANDLE_DISABLED", prior);
  }
  assertEquals(detectSeedServer("sample.handle")?.kind, "username");
});

Deno.test("WIRING (source assertion): /health publishes checks.seed_dotted_handle from the real self-test", async () => {
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes('import { seedDottedHandleSelfTest } from "./validation.ts";'));
  assert(health.includes("r.checks.seed_dotted_handle = seedDottedHandleSelfTest();"));
});

Deno.test("WIRING (source assertion): the thread's stored seed type comes from detectSeedServer", async () => {
  const auth = await Deno.readTextFile(new URL("../../functions/osint-agent/auth.ts", import.meta.url));
  assert(auth.includes("const detected = isNewInvestigation ? detectSeedServer(text) : null;"));
  assert(auth.includes("...(detected ? { seed_type: detected.kind } : {}),"));
});
