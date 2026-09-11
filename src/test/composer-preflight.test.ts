import { describe, expect, it } from "vitest";
import { DEFAULT_CONTROLS, evaluatePreflight, type PreflightControls } from "@/lib/composer-preflight";

/**
 * The composer preflight. The load-bearing rule: a bare seed is sent
 * byte-for-byte as typed — the investigation cache, seed detection and the
 * opening-phase gate all key on that text — and Scope & controls are added
 * only when the analyst changed one.
 */

const run = (text: string, over: Partial<PreflightControls> = {}, extra: { isFollowUp?: boolean; attachments?: number } = {}) =>
  evaluatePreflight({
    text,
    attachments: extra.attachments ?? 0,
    isFollowUp: extra.isFollowUp ?? false,
    controls: { ...DEFAULT_CONTROLS, ...over },
  });

describe("evaluatePreflight", () => {
  it("empty prompt: not submittable, and not an error either", () => {
    const r = run("   ");
    expect(r.empty).toBe(true);
    expect(r.canSubmit).toBe(false);
    expect(r.errors).toEqual({});
  });

  it("a bare seed is valid and sent exactly as typed", () => {
    const r = run("  jordan.vale@example.test  ");
    expect(r.canSubmit).toBe(true);
    expect(r.customized).toBe(false);
    expect(r.message).toBe("jordan.vale@example.test");
    expect(r.target).toMatchObject({ value: "jordan.vale@example.test", kind: "email", freeText: false });
  });

  it("finds the target inside a question", () => {
    const r = run("jordan.vale@example.test — who controls this mailbox?");
    expect(r.target).toMatchObject({ value: "jordan.vale@example.test", kind: "email" });
  });

  it("accepts a free-text target (a person's name) — name investigations are real", () => {
    const r = run("Tristen Ufland, Sacramento");
    expect(r.canSubmit).toBe(true);
    expect(r.target?.freeText).toBe(true);
    expect(r.summary.target).toMatch(/free text/);
  });

  it("invalid target: a chosen type that the request does not contain", () => {
    const r = run("Tristen Ufland", { targetKind: "email" });
    expect(r.canSubmit).toBe(false);
    expect(r.errors.target).toMatch(/No email found/);
  });

  it("a corrected type is valid, and is stated in the instructions", () => {
    // "john.smith" reads as a domain; the analyst knows it is a handle.
    const r = run("john.smith", { targetKind: "username" });
    expect(r.target).toMatchObject({ kind: "username", corrected: true });
    expect(r.canSubmit).toBe(true);
    expect(r.customized).toBe(true);
    expect(r.message).toContain("Target: john.smith (username)");
  });

  it("re-selecting the detected type changes nothing that is sent", () => {
    const r = run("jharker88", { targetKind: "username" });
    expect(r.customized).toBe(false);
    expect(r.message).toBe("jharker88");
  });

  it("invalid objective: a placeholder, a single word, or the target repeated", () => {
    expect(run("jordan.vale@example.test", { objective: "tbd" }).errors.objective).toBeTruthy();
    expect(run("jordan.vale@example.test", { objective: "ownership" }).errors.objective).toBeTruthy();
    expect(run("jordan.vale@example.test", { objective: "jordan.vale@example.test" }).errors.objective).toBeTruthy();
    expect(run("jordan.vale@example.test", { objective: "tbd" }).canSubmit).toBe(false);
  });

  it("valid preflight: custom controls are appended as labelled, advisory instructions", () => {
    const r = run("jordan.vale@example.test", {
      objective: "Who controls this mailbox today?",
      depth: "deep",
      scope: "public_no_sensitive",
      exclusions: "no relatives",
    });
    expect(r.canSubmit).toBe(true);
    expect(r.message.startsWith("jordan.vale@example.test\n")).toBe(true);
    expect(r.message).toContain("Scope & controls (analyst instructions)");
    expect(r.message).toContain("Objective: Who controls this mailbox today?");
    expect(r.message).toContain("Authorized scope: Public sources, excluding breach and broker data");
    expect(r.message).toContain("Exclusions: no relatives");
    expect(r.message).toMatch(/Depth: Deep pass/);
    expect(r.summary).toMatchObject({ objective: "Who controls this mailbox today?", depth: "Deep", budget: "Server per-run cap" });
  });

  it("states the agent default when no objective is given, rather than inventing one", () => {
    expect(run("jordan.vale@example.test").summary.objective).toMatch(/Agent default/);
  });

  it("a follow-up needs no new target", () => {
    const r = run("now check the phone number", {}, { isFollowUp: true });
    expect(r.canSubmit).toBe(true);
    expect(r.message).toBe("now check the phone number");
  });

  it("attachments alone are a valid first request", () => {
    expect(run("", {}, { attachments: 1 }).canSubmit).toBe(true);
  });

  it("never de-duplicates — the same text twice is two identical, valid requests", () => {
    expect(run("jordan.vale@example.test").message).toBe(run("jordan.vale@example.test").message);
    expect(run("jordan.vale@example.test").canSubmit).toBe(true);
  });
});
