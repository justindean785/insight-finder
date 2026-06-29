import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { countRecordArtifactCalls } from "./guard.ts";

/**
 * Tests for the zero-artifact completion safety-net helper (index.ts uses this
 * to tell "ran lookups but never recorded" from "genuinely empty").
 */

Deno.test("countRecordArtifactCalls counts tool + record_artifacts parts", () => {
  const messages = [
    { parts: [{ type: "step-start" }, { type: "tool-whois_lookup" }, { type: "text" }] },
    { parts: [{ type: "tool-dns_records" }, { type: "tool-record_artifacts" }] },
    { parts: [{ type: "dynamic-tool" }, { type: "tool-record_artifact" }] },
  ];
  const r = countRecordArtifactCalls(messages);
  // tool-whois, tool-dns, tool-record_artifacts, dynamic-tool, tool-record_artifact = 5 tool parts
  assertEquals(r.toolCalls, 5);
  // tool-record_artifacts + tool-record_artifact = 2 record calls
  assertEquals(r.recordCalls, 2);
});

Deno.test("countRecordArtifactCalls flags the record gap: lookups ran, nothing recorded", () => {
  const messages = [
    { parts: [{ type: "tool-whois_lookup" }] },
    { parts: [{ type: "tool-dns_records" }] },
    { parts: [{ type: "tool-minimax_web_search" }] },
    { parts: [{ type: "tool-leakcheck_lookup" }] },
    { parts: [{ type: "text" }] }, // narrated report, no record
  ];
  const r = countRecordArtifactCalls(messages);
  assertEquals(r.recordCalls, 0);
  assertEquals(r.toolCalls > 3, true); // findings_likely heuristic fires
});

Deno.test("countRecordArtifactCalls tolerates missing/empty parts", () => {
  assertEquals(countRecordArtifactCalls([]), { toolCalls: 0, recordCalls: 0 });
  assertEquals(countRecordArtifactCalls([{}, { parts: [] }]), { toolCalls: 0, recordCalls: 0 });
});
