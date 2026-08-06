/**
 * migration-digest-qualification.test.ts — pgcrypto's digest() must stay
 * schema-qualified in record_analyst_feedback.
 *
 * THE DEFECT. 20260717000000 created the function as SECURITY DEFINER with
 * `SET search_path = public` while calling unqualified `digest(...)`. On
 * Supabase, pgcrypto installs into `extensions`, not `public` (verified live:
 * 2 overloads in `extensions`, 0 in `public`), so every non-deduped write
 * raised `function digest(text, unknown) does not exist`.
 *
 * WHY A TEST AND NOT JUST A MIGRATION. This has already regressed once. The
 * 2026-07-18 repair was applied straight to production and its migration was
 * never merged, so nothing in the repo asserted the correct shape — and a
 * later "pin mutable search_path" security pass re-pinned the function to
 * `public` with nothing to catch it. It survived only because the repaired
 * body was qualified, which is search_path-independent.
 *
 * The migration-time guard in 20260806000001 fires once, on apply. This runs
 * on every CI build, so a NEW migration that reintroduces a bare call fails
 * here immediately rather than silently shipping a dead write path.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = path.resolve(process.cwd(), "supabase/migrations");
const FN = "record_analyst_feedback";

/** Call sites only: ignores comment lines and any `x.digest(` qualified call. */
function bareDigestCallSites(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .filter((l) => /(^|[^.\w])digest\s*\(/i.test(l));
}

function migrationsDefining(fn: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => new RegExp(`FUNCTION\\s+public\\.${fn}\\b`, "i").test(
      readFileSync(path.join(MIGRATIONS, f), "utf8"),
    ))
    .sort();
}

describe("record_analyst_feedback keeps digest() schema-qualified", () => {
  it("is defined by at least one migration", () => {
    expect(migrationsDefining(FN).length).toBeGreaterThan(0);
  });

  it("the LAST migration defining it has zero unqualified digest() call sites", () => {
    // Migrations apply in filename order, so only the final definition decides
    // what a fresh database ends up running.
    const files = migrationsDefining(FN);
    const last = files[files.length - 1];
    const sql = readFileSync(path.join(MIGRATIONS, last), "utf8");
    expect(bareDigestCallSites(sql)).toEqual([]);
  });

  it("the LAST definition actually calls extensions.digest", () => {
    // Guards the inverse mistake: dropping the hashing entirely would also
    // produce zero bare call sites.
    const files = migrationsDefining(FN);
    const sql = readFileSync(path.join(MIGRATIONS, files[files.length - 1]), "utf8");
    expect(sql).toMatch(/extensions\.digest\s*\(/);
  });

  it("the historical broken migration is still present and still broken", () => {
    // Pins the premise: 20260717 is NOT edited in place (it is already applied
    // everywhere), so the corrective migration is what must win. If someone
    // "fixes" the old file instead, this fails and points them here.
    const sql = readFileSync(
      path.join(MIGRATIONS, "20260717000000_analyst_feedback_events.sql"),
      "utf8",
    );
    expect(bareDigestCallSites(sql).length).toBeGreaterThan(0);
  });
});
