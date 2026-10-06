import { describe, expect, it } from "vitest";
import { DEFAULT_CONTROLS, evaluatePreflight, type PreflightControls } from "@/lib/composer-preflight";

/**
 * The composer preflight. The load-bearing rule: a bare seed is sent
 * byte-for-byte as typed — the investigation cache, seed detection and the
 * opening-phase gate all key on that text — and the only thing ever added is
 * one Target line, when the analyst corrected the detected type.
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

  it("a corrected type adds exactly one line — never the old Scope & controls block", () => {
    const r = run("john.smith", { targetKind: "username" });
    expect(r.message).toBe("john.smith\n\nTarget: john.smith (username)");
    expect(r.message).not.toMatch(/Scope & controls|analyst instructions|Authorized scope|Depth:/);
  });

  it("the pre-submit summary names the target and nothing the run does not honour", () => {
    expect(run("jordan.vale@example.test").summary).toEqual({ target: "jordan.vale@example.test (email)" });
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
