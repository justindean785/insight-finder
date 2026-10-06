import { describe, expect, it } from "vitest";
import {
  markMarkdown,
  redactSecretsDeep,
  redactSecretsInText,
  SECRET_MASK,
  wrapJsonExport,
  type ExportGate,
} from "@/lib/report-export-gate";

/**
 * Export-time credential masking. The workbench flag REVEAL_BREACH_DATA is a
 * settled decision and stays ON (CLAUDE.md); these tests cover only what leaves
 * the app. Shapes are the exact artifact VALUE strings the breach extractors
 * wrote on production thread d72fa44a (2026-09-20), with the secrets replaced.
 */
const gate: ExportGate = { mode: "draft", mark: "UNVERIFIED DRAFT", readinessPct: 3, reasons: ["Report readiness is 3%"] };

describe("redactSecretsInText", () => {
  it("masks password='…' assignments", () => {
    expect(redactSecretsInText("Serus scan: 7 breaches, password='hunter2', extracted name='Terence'"))
      .toBe(`Serus scan: 7 breaches, password=${SECRET_MASK}, extracted name='Terence'`);
  });
  it("masks a bare 'passwords a b c' list up to the next labelled field", () => {
    const s = "cnn@example.com - Serus 24 breaches: passwords abc2001 def1 ghi@1; name Desiree Example; phones 8087838763";
    expect(redactSecretsInText(s))
      .toBe(`cnn@example.com - Serus 24 breaches: passwords ${SECRET_MASK}; name Desiree Example; phones 8087838763`);
  });
  it("leaves handles, hashes-as-words and ordinary prose alone", () => {
    const s = "Breach exposure: lildee808 (oathnet_db) — fields: Email, Password, Name";
    expect(redactSecretsInText(s)).toBe(s);
    expect(redactSecretsInText("hibp_pwned_passwords_kanon returned 0")).toBe("hibp_pwned_passwords_kanon returned 0");
  });
});

describe("redactSecretsDeep", () => {
  it("masks secret-named metadata keys and password phrases inside values, keeps everything else", () => {
    const row = {
      value: "x@example.com - Serus: password='hunter2'",
      metadata: {
        passwords: ["abc2001", "def1"],
        extracted_password: "hunter2",
        extracted_name: "Terence",
        phones: ["8087838763"],
        nested: { password: "p", keep: 1 },
      },
    };
    const out = redactSecretsDeep(row);
    expect(out.value).toBe(`x@example.com - Serus: password=${SECRET_MASK}`);
    expect(out.metadata.passwords).toEqual([SECRET_MASK, SECRET_MASK]);
    expect(out.metadata.extracted_password).toBe(SECRET_MASK);
    expect(out.metadata.extracted_name).toBe("Terence");
    expect(out.metadata.phones).toEqual(["8087838763"]);
    expect(out.metadata.nested).toEqual({ password: SECRET_MASK, keep: 1 });
    // Input untouched — the workbench keeps the raw row.
    expect(row.metadata.extracted_password).toBe("hunter2");
  });
});

describe("export wrappers apply the masking", () => {
  it("markMarkdown masks the body on both draft and report-safe paths", () => {
    const md = "| a | password='hunter2' |";
    expect(markMarkdown(md, gate, "t")).toContain(`password=${SECRET_MASK}`);
    expect(markMarkdown(md, gate, "t")).not.toContain("hunter2");
    const safe: ExportGate = { mode: "report-safe", mark: "REPORT-SAFE", readinessPct: 80, reasons: [] };
    expect(markMarkdown(md, safe, "t")).not.toContain("hunter2");
  });
  it("wrapJsonExport masks records", () => {
    const json = wrapJsonExport([{ metadata: { passwords: ["hunter2"] } }], gate, "t");
    expect(json).not.toContain("hunter2");
    expect(json).toContain(SECRET_MASK);
  });
});

/**
 * ⚠️ SCOPE PIN — what masking does NOT cover.
 *
 * `SECRET_KEY_RE` and the password regexes cover passwords, passcodes and
 * hashes. Nothing else. SSNs, DOBs and partial card numbers pass through every
 * export format untouched. Verified against a real production export
 * (2026-09-22): a 9-digit SSN carried in an NPD breach row survived the JSON
 * path intact while the passwords in the same document were masked.
 *
 * This is not asserted as desirable — it is asserted so the export LABELS stay
 * truthful. The menu says "passwords masked" because that is what is true; if
 * anyone widens the label to "secrets", this test must be updated in the same
 * change, which is the point.
 */
describe("masking scope is passwords only — labels must not over-claim", () => {
  it("does NOT mask an SSN, a DOB, or a partial card number", () => {
    const row =
      "NPD (2024) — name JANE DOE, ssn 123456789, dob 1970-02-03, cc last4 4321, password hunter2";
    const out = redactSecretsInText(row);
    expect(out, "password must be masked").toContain(SECRET_MASK);
    expect(out, "SSN is NOT masked — label says passwords, not secrets").toContain("123456789");
    expect(out, "DOB is NOT masked").toContain("1970-02-03");
    expect(out, "partial card is NOT masked").toContain("4321");
  });

  it("deep redaction masks a password key but leaves an ssn key alone", () => {
    const out = redactSecretsDeep({ password: "hunter2", ssn: "123456789", dob: "1970-02-03" });
    expect(out.password).toBe(SECRET_MASK);
    expect(out.ssn).toBe("123456789");
    expect(out.dob).toBe("1970-02-03");
  });
});
