import { describe, expect, it } from "vitest";
import { byteLength, measureRequestBody } from "@/lib/request-size";

/**
 * What the CLIENT uploads per turn. Distinct from every prompt-size meter we
 * have: those measure what the server PREPARES for the model, after trimming.
 * `useChat` pushes the whole messages array first, unbounded — so a long case
 * can be cheap for the model and still slow to send on a phone.
 */
const msg = (role: string, text: string, parts?: unknown[]) => ({
  id: `m-${text.slice(0, 4)}`,
  role,
  parts: parts ?? [{ type: "text", text }],
});

describe("byteLength", () => {
  it("counts BYTES, not UTF-16 code units", () => {
    // The whole reason this exists. "é" is 1 code unit but 2 UTF-8 bytes; an
    // emoji is 2 code units and 4 bytes. `.length` under-reports the real
    // upload on any non-ASCII case — accented names, CJK handles, scraped bios.
    expect("é".length).toBe(1);
    expect(byteLength("é")).toBe(2);
    expect("🙂".length).toBe(2);
    expect(byteLength("🙂")).toBe(4);
    expect(byteLength("abc")).toBe(3);
  });

  it("handles null, binary and unserializable input without throwing", () => {
    expect(byteLength(null)).toBe(0);
    expect(byteLength(undefined)).toBe(0);
    expect(byteLength(new Uint8Array([1, 2, 3]))).toBe(3);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(byteLength(cyclic)).toBe(0);
  });
});

describe("measureRequestBody", () => {
  it("reports the breakdown for a normal chat body", () => {
    const body = JSON.stringify({
      threadId: "t1",
      messages: [msg("user", "seed"), msg("assistant", "a much longer assistant reply here")],
    });
    const m = measureRequestBody(body);
    expect(m.parsed).toBe(true);
    expect(m.bytes).toBe(byteLength(body));
    expect(m.messages).toBe(2);
    expect(m.largestMessageRole).toBe("assistant");
    expect(m.largestMessageBytes).toBeGreaterThan(0);
  });

  it("attributes tool-result parts, which is where a long case actually grows", () => {
    const big = "x".repeat(5000);
    const body = JSON.stringify({
      threadId: "t1",
      messages: [
        msg("user", "seed"),
        { id: "m2", role: "assistant", parts: [
          { type: "text", text: "short" },
          { type: "tool-breach_check", toolCallId: "c1", state: "output-available", output: { ok: true, raw: big } },
        ] },
      ],
    });
    const m = measureRequestBody(body);
    expect(m.toolPartBytes).toBeGreaterThan(5000);
    // The tool part dominates the body — the signal that says "this is why the
    // upload is slow", which a bare byte count could not tell you.
    expect(m.toolPartBytes! / m.bytes).toBeGreaterThan(0.8);
  });

  it("a body that is not our JSON shape still reports TRUE bytes, with the breakdown null", () => {
    // Never guess. An unparseable body is still a real upload.
    const m = measureRequestBody("not json at all");
    expect(m.bytes).toBe(15);
    expect(m.parsed).toBe(false);
    expect(m.messages).toBeNull();
    expect(m.largestMessageBytes).toBeNull();
    expect(m.toolPartBytes).toBeNull();
  });

  it("valid JSON without a messages array is not treated as parsed", () => {
    const m = measureRequestBody(JSON.stringify({ threadId: "t1" }));
    expect(m.parsed).toBe(false);
    expect(m.messages).toBeNull();
    expect(m.bytes).toBeGreaterThan(0);
  });

  it("an absent body measures zero rather than throwing", () => {
    expect(measureRequestBody(undefined).bytes).toBe(0);
    expect(measureRequestBody(null).bytes).toBe(0);
  });
});
