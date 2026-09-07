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
  resolve(process.cwd(), "supabase/migrations/20260829000000_delete_my_account.sql"),
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

describe("#476 account deletion — hardening", () => {
  it("uses an EMPTY search_path, not merely an explicit one", () => {
    // The maximally safe setting for SECURITY DEFINER: with no schema on the
    // path an unqualified name cannot resolve to an attacker-planted object, and
    // the function stops depending on who holds CREATE on public/auth.
    //
    // Asserted against the DDL with `--` comments stripped: the header
    // deliberately DISCUSSES the weaker `search_path = public, auth` it replaced,
    // and a naive whole-file match would read that prose as the setting.
    const ddl = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(ddl).toMatch(/SET search_path = ''/);
    expect(ddl).not.toMatch(/SET search_path = public/);
  });

  it("schema-qualifies every reference, so the empty path is survivable", () => {
    const body = migration.slice(migration.indexOf("AS $$"), migration.indexOf("$$;"));
    // Every DELETE target and every FROM must carry a schema.
    for (const m of body.matchAll(/DELETE FROM\s+(\S+)/g)) {
      expect(m[1], `unqualified DELETE target: ${m[1]}`).toMatch(/^(public|auth)\./);
    }
    expect(body).toMatch(/auth\.uid\(\)/);
    expect(body).toMatch(/pg_catalog\.to_regclass/);
  });

  it("keeps dynamic SQL as fixed text with the caller value bound, never interpolated", () => {
    const body = migration.slice(migration.indexOf("AS $$"), migration.indexOf("$$;"));
    for (const m of body.matchAll(/EXECUTE\s+([^;]+);/g)) {
      const stmt = m[1];
      expect(stmt, `dynamic SQL must be a single-quoted literal: ${stmt}`).toMatch(/^'[^']*'/);
      expect(stmt, `dynamic SQL must not concatenate: ${stmt}`).not.toMatch(/\|\|/);
      expect(stmt, `dynamic SQL must bind, not inline: ${stmt}`).toMatch(/USING /);
    }
  });

  it("distinguishes schema rollback from deleted-data recovery", () => {
    // Conflating the two would read as "this is reversible", which it is not.
    expect(migration).toMatch(/SCHEMA rollback/i);
    expect(migration).toMatch(/DELETED-DATA recovery/i);
    expect(migration).toMatch(/NOT POSSIBLE/i);
  });

  it("does not claim an already-issued access token is instantly invalidated", () => {
    expect(migration).toMatch(/stateless signed JWT/i);
    expect(migration).not.toMatch(/immediately invalidat|instantly invalidat/i);
    // The UI must state the same thing, not something more reassuring.
    expect(settings).toMatch(/stays valid until it expires/i);
  });

  it("clears locally cached case data, not just the auth token", () => {
    expect(settings).toMatch(/clearLocalCaseState\(\)/);
    // The case-scoped keys are built per thread and per tool call, so the clear
    // must be prefix-based rather than an enumerated list.
    for (const prefix of ['"proximity:"', '"brain_"', '"sb-"']) {
      expect(settings).toContain(prefix);
    }
  });

  it("does not report failure after the server already deleted the account", () => {
    // signOut targets a user that no longer exists; letting it throw would show
    // "Could not delete the account" for a completed, irreversible deletion.
    const handler = settings.slice(settings.indexOf("const deleteAccount"));
    const signOut = handler.slice(handler.indexOf("supabase.auth.signOut"));
    expect(handler.slice(0, handler.indexOf("supabase.auth.signOut"))).toMatch(/try \{/);
    expect(signOut).toMatch(/\} catch \{/);
  });
});
