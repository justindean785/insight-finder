// replay/co-record-fields.ts — ZERO IMPORTS on purpose.
//
// A copy of `CO_RECORD_FIELDS` from `src/lib/intel.ts`: the metadata keys whose value
// a record states is another selector OF THE SAME RECORD. Deno cannot import `@/lib`,
// so the list is duplicated here and pinned by `src/test/replay-co-record-pin.test.ts`
// (the same duplicate-and-pin seam `lib/evidence-record.ts` uses). If the frontend
// list changes, that test fails until this copy is updated.
//
// Password, IP, address, DOB, device, breach-name and name fields are deliberately
// absent: those values are shared by construction and never link.
export type CoRecordClass = "email" | "phone" | "handle";

export const CO_RECORD_FIELDS: Readonly<Record<string, CoRecordClass>> = {
  email_associated: "email",
  linked_email: "email",
  email_in_breach: "email",
  phone_associated: "phone",
  linked_phone: "phone",
  phone_in_breach: "phone",
  instagram_username: "handle",
  username_in_breach: "handle",
  linked_username: "handle",
};

/** More than this many distinct selectors of one class in one record = a dump row. */
export const CO_RECORD_MAX_TARGETS_PER_CLASS = 3;
