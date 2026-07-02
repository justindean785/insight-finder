import { describe, expect, it } from "vitest";
import { DELETE_CONFIRM_PHRASE, isDeleteConfirmed } from "@/lib/delete-account-guard";

describe("isDeleteConfirmed — type-to-confirm gate for account deletion", () => {
  it("blocks the empty input", () => {
    expect(isDeleteConfirmed("")).toBe(false);
  });

  it("blocks a partial or wrong phrase", () => {
    expect(isDeleteConfirmed("DELET")).toBe(false);
    expect(isDeleteConfirmed("delete my account")).toBe(false);
    expect(isDeleteConfirmed("CONFIRM")).toBe(false);
  });

  it("allows the exact phrase", () => {
    expect(isDeleteConfirmed(DELETE_CONFIRM_PHRASE)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDeleteConfirmed("delete")).toBe(true);
    expect(isDeleteConfirmed("DeLeTe")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isDeleteConfirmed("  DELETE  ")).toBe(true);
    expect(isDeleteConfirmed("\nDELETE\t")).toBe(true);
  });

  it("does not tolerate internal whitespace", () => {
    expect(isDeleteConfirmed("DE LETE")).toBe(false);
  });
});
