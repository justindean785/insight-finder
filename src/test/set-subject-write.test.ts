import { describe, it, expect } from "vitest";
import {
  SET_SUBJECT_NO_ROWS_MESSAGE, writeSubject,
  type SubjectPatch, type SubjectWriteChain, type SubjectWriteClient,
} from "@/lib/set-subject";

/**
 * The write behind "Set as case subject". Two defects were found in review of #983:
 *  1. PostgREST returns NO error when RLS filters an UPDATE down to zero rows, so a
 *     refused write looked like success ("Case subject set").
 *  2. No concurrency token: a seed changed by another tab or an edge turn between
 *     the click and the write was silently overwritten.
 * The fake below records the exact filter chain and returns whatever the test says
 * PostgREST would, so these assert on the REQUEST that would be sent.
 */

type Result = { data: { id: string }[] | null; error: { message: string } | null };

function fakeClient(result: Result) {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: SubjectWriteChain = {
    eq: (c, v) => (calls.push(["eq", c, v]), chain),
    is: (c, v) => (calls.push(["is", c, v]), chain),
    select: (cols) => (calls.push(["select", cols]), chain),
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  const client: SubjectWriteClient = {
    from: (t) => (calls.push(["from", t]), { update: (p) => (calls.push(["update", p]), chain) }),
  };
  return { client, calls };
}

const patch: SubjectPatch = { seed_value: "subject@mail.example", seed_type: "email", title: "subject@mail.example" };
const SEEN = "Attached files:\n- [scan-notes.pdf](https://proj.storage.example/x?token=abc";

describe("writeSubject — a refused write is not a success (defect 1)", () => {
  it("treats zero returned rows as failure, not success", async () => {
    const { client } = fakeClient({ data: [], error: null });
    const r = await writeSubject(client, "t1", SEEN, patch);
    expect(r).toEqual({ ok: false, reason: "no_rows" });
  });

  it("treats a null data payload with no error as failure too", async () => {
    const { client } = fakeClient({ data: null, error: null });
    expect((await writeSubject(client, "t1", SEEN, patch)).ok).toBe(false);
  });

  it("asks PostgREST to return the written row (otherwise zero rows is unobservable)", async () => {
    const { client, calls } = fakeClient({ data: [{ id: "t1" }], error: null });
    await writeSubject(client, "t1", SEEN, patch);
    expect(calls).toContainEqual(["select", "id"]);
  });

  it("succeeds when exactly the one row comes back", async () => {
    const { client } = fakeClient({ data: [{ id: "t1" }], error: null });
    expect(await writeSubject(client, "t1", SEEN, patch)).toEqual({ ok: true });
  });

  it("surfaces a database error as an error, not as no_rows", async () => {
    const { client } = fakeClient({ data: null, error: { message: "boom" } });
    expect(await writeSubject(client, "t1", SEEN, patch)).toEqual({ ok: false, reason: "error", message: "boom" });
  });
});

describe("writeSubject — compare-and-set on the seed the client saw (defect 2)", () => {
  it("filters on the id AND on the seed_value the client saw", async () => {
    const { client, calls } = fakeClient({ data: [{ id: "t1" }], error: null });
    await writeSubject(client, "t1", SEEN, patch);
    expect(calls).toContainEqual(["eq", "id", "t1"]);
    expect(calls).toContainEqual(["eq", "seed_value", SEEN]);
  });

  it("uses IS NULL for a null seed (eq.null never matches a NULL column in PostgREST)", async () => {
    const { client, calls } = fakeClient({ data: [{ id: "t1" }], error: null });
    await writeSubject(client, "t1", null, patch);
    expect(calls).toContainEqual(["is", "seed_value", null]);
    expect(calls.some((c) => c[0] === "eq" && c[1] === "seed_value")).toBe(false);
  });

  it("sends exactly the patch and nothing else", async () => {
    const { client, calls } = fakeClient({ data: [{ id: "t1" }], error: null });
    await writeSubject(client, "t1", SEEN, patch);
    expect(calls.filter((c) => c[0] === "update")).toEqual([["update", patch]]);
  });
});

describe("SET_SUBJECT_NO_ROWS_MESSAGE", () => {
  it("tells the analyst to reload and never blames permissions (RLS vs changed seed is indistinguishable)", () => {
    expect(SET_SUBJECT_NO_ROWS_MESSAGE).toMatch(/reload/i);
    expect(SET_SUBJECT_NO_ROWS_MESSAGE).not.toMatch(/permission|denied|not allowed|cannot edit/i);
  });
});
