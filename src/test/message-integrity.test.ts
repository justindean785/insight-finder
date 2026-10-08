import { describe, expect, it } from "vitest";
import { messageIntegrity, narrativeIsUnadjudicated } from "@/lib/message-integrity";

// Sanitized shape of the production message: finished steps, a text part cut off mid-stream,
// then a server-appended text part with no `state`.
const prodShape = [
  { type: "text", text: "Hunter confirms the email is undeliverable.", state: "done" },
  { type: "text", text: "All", state: "streaming" },
  { type: "text", text: "# Findings Report: example.test\n…" },
];

describe("messageIntegrity", () => {
  it("flags a persisted message whose text part was cut off and followed by appended text", () => {
    expect(messageIntegrity(prodShape, false)).toEqual({ interrupted: true, appendedAfterInterruption: true });
  });
  it("flags an interrupted message with nothing appended", () => {
    expect(messageIntegrity(prodShape.slice(0, 2), false)).toEqual({ interrupted: true, appendedAfterInterruption: false });
  });
  it("never flags the message that is still streaming", () => {
    expect(messageIntegrity(prodShape, true)).toEqual({ interrupted: false, appendedAfterInterruption: false });
  });
  it("does not flag a finished message", () => {
    expect(messageIntegrity([{ type: "text", text: "ok", state: "done" }], false).interrupted).toBe(false);
  });
  it("treats an empty appended part as not appended, and tolerates bad input", () => {
    expect(messageIntegrity([{ type: "text", text: "a", state: "streaming" }, { type: "text", text: "  " }], false).appendedAfterInterruption).toBe(false);
    expect(messageIntegrity(null, false).interrupted).toBe(false);
    expect(messageIntegrity(undefined, false).interrupted).toBe(false);
  });
  it("ignores non-text parts", () => {
    expect(messageIntegrity([{ type: "tool-x", state: "streaming" }], false).interrupted).toBe(false);
  });
});

describe("narrativeIsUnadjudicated", () => {
  it("recognizes the server's own no-authoritative-rows line", () => {
    expect(narrativeIsUnadjudicated("…_No authoritative finding rows were recorded for this run._ 19 artifacts…")).toBe(true);
  });
  it("is false for prose that merely says confirmed", () => {
    expect(narrativeIsUnadjudicated("Confirmed findings: …")).toBe(false);
  });
});
