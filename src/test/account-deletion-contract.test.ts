import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #476 — self-service account deletion (CCPA/GDPR beta blocker).
//
// The property that matters here is not "rows are deleted" (the migration is
// exercised against a real Postgres by CI's migrations job). It is that the UI
// tells the truth about what SURVIVES.
//
// public.analyst_feedback_events is append-only by design: BEFORE UPDATE,
// BEFORE DELETE and BEFORE TRUNCATE triggers raise for every caller including
// service_role, because it is a per-thread hash-chained integrity record. It
// therefore cannot be deleted, and a flow that says "everything is deleted"
// would be making a false compliance claim. The disclosure is what makes the
// retention something you can lawfully rely on — so it is pinned here, before
// the confirm control, rather than left to survive a future copy edit.

const settings = readFileSync(resolve(process.cwd(), "src/pages/Settings.tsx"), "utf8");
const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260825000000_delete_my_account.sql"),
  "utf8",
);

describe("#476 account deletion — UI contract", () => {
  it("requires a typed confirmation, not a single click", () => {
    expect(settings).toMatch(/deleteConfirm !== "DELETE"/);
  });

  it("guards the handler itself, not only the disabled attribute", () => {
    // A `disabled` prop is an affordance, not an authorization check.
    const handler = settings.slice(settings.indexOf("const deleteAccount"));
    expect(handler).toMatch(/if \(deleteConfirm !== "DELETE" \|\| deleting\) return;/);
  });

  it("discloses the retained audit log BEFORE the confirm control", () => {
    const disclosureAt = settings.search(/append-only and is retained/i);
    const confirmAt = settings.indexOf("Type <span");
    expect(disclosureAt).toBeGreaterThan(-1);
    expect(confirmAt).toBeGreaterThan(-1);
    expect(disclosureAt).toBeLessThan(confirmAt);
  });

  it("does not claim that everything is deleted", () => {
    // Guards against a copy edit that removes the exception and leaves an
    // absolute promise the system cannot keep.
    const section = settings.slice(settings.indexOf("Delete account"), settings.indexOf("Sign out"));
    expect(section).toMatch(/One exception/i);
    expect(section).not.toMatch(/deletes everything|all of your data is deleted|erases everything/i);
  });

  it("signs out afterwards so no stale token is left behind", () => {
    const handler = settings.slice(settings.indexOf("const deleteAccount"));
    expect(handler).toMatch(/auth\.signOut\(\)/);
  });
});

describe("#476 account deletion — migration contract", () => {
  it("is caller-scoped: takes no arguments and derives auth.uid()", () => {
    // Taking a user id would let a caller who controls the argument aim it at
    // another account.
    expect(migration).toMatch(/delete_my_account\(\)\s*\nRETURNS/);
    expect(migration).toMatch(/_uid uuid := auth\.uid\(\)/);
  });

  it("refuses an unauthenticated caller", () => {
    expect(migration).toMatch(/IF _uid IS NULL THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it("pins search_path (every SECURITY DEFINER function here must)", () => {
    expect(migration).toMatch(/SECURITY DEFINER[\s\S]*SET search_path =/);
  });

  it("revokes execute from anon and PUBLIC", () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.delete_my_account\(\) FROM public;/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.delete_my_account\(\) FROM anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.delete_my_account\(\) TO authenticated;/);
  });

  it("never touches the append-only feedback log", () => {
    // It may COUNT those rows for the receipt; it must not DELETE them. Adding
    // such a delete would raise and abort the whole transaction, leaving the
    // account half-removed — which is worse than the documented retention.
    expect(migration).not.toMatch(/DELETE FROM public\.analyst_feedback_events/i);
    expect(migration).toMatch(/SELECT count\(\*\) INTO _retained[\s\S]*analyst_feedback_events/);
  });

  it("reports what it retained, so the receipt is not silently partial", () => {
    expect(migration).toMatch(/'retained',\s*jsonb_build_object/);
  });

  it("deletes the auth user last", () => {
    // Once auth.users is gone the caller's auth.uid() no longer resolves, so any
    // delete ordered after it would silently match nothing.
    const authDelete = migration.indexOf("DELETE FROM auth.users");
    const lastPublicDelete = migration.lastIndexOf("DELETE FROM public.");
    expect(authDelete).toBeGreaterThan(lastPublicDelete);
  });
});
