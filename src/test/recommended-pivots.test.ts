import { describe, expect, it } from "vitest";
import { extractRecommendedPivots, isPlausiblePhone } from "@/lib/recommended-pivots";
import { isWellFormedTarget, type PivotTargetType } from "@/lib/pivot-target-shape";

describe("extractRecommendedPivots", () => {
  it("extracts the final report recommendations in display order", () => {
    const text = `
**Recommended next pivots:**
- Investigate sam.cole@example.com — same person, 3-breach corroboration
- Investigate Exavier Hill-Larot — independent identity check
- Cross-reference Exavier Hill-Larot's Oakley PO Box with public records
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots.map((pivot) => pivot.label)).toEqual([
      "Investigate sam.cole@example.com — same person, 3-breach corroboration",
      "Investigate Exavier Hill-Larot — independent identity check",
      "Cross-reference Exavier Hill-Larot's Oakley PO Box with public records",
    ]);
    expect(pivots[0]).toMatchObject({
      value: "sam.cole@example.com",
      type: "email",
      actionLabel: "Investigate email",
      detail: "sam.cole@example.com · same person, 3-breach corroboration",
    });
    expect(pivots[1]).toMatchObject({
      value: "Exavier Hill-Larot",
      type: "name",
      actionLabel: "Review lead",
    });
  });

  it("does not treat later report sections as pivots", () => {
    const text = `
## Recommended Next Pivots
1. Pivot on 66.87.118.76 — validate network history
## Sources
- source.example
`;
    expect(extractRecommendedPivots(text)).toHaveLength(1);
  });

  it("keeps extracting when a corroborate/confirm pivot line ends with a colon", () => {
    // Regression: extractTarget recognizes corroborate/confirm/compare, but the
    // section-break guard's verb list used to omit them, so a "Corroborate …:"
    // line was misread as a heading and stopped extraction after the first pivot.
    const text = `
**Recommended next pivots:**
- Investigate sam.cole@example.com — same person
- Corroborate the Oakley PO Box with county records:
- Confirm Exavier Hill-Larot via independent identity check
`;
    const labels = extractRecommendedPivots(text).map((pivot) => pivot.label);
    expect(labels).toContain("Corroborate the Oakley PO Box with county records:");
    expect(labels).toContain("Confirm Exavier Hill-Larot via independent identity check");
    expect(labels).toHaveLength(3);
  });

  it("blocks sensitive secret-like pivots and minor-related pivots", () => {
    const text = `
## Recommended Next Pivots
- Verify leaked password hunter2 — direct breach secret
- Investigate teen profile tie-in — possible minor
- Check 925-642-7442 — corroborate line ownership
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots).toHaveLength(1);
    expect(pivots[0]).toMatchObject({
      value: "925-642-7442",
      type: "phone",
      actionLabel: "Check phone association",
    });
  });

  it("drops source-infrastructure domains but keeps genuine subject domains", () => {
    // Regression: report-recommended domains like the CA SOS bizfile portal,
    // linkedin.com, and opencorporates.com are OSINT *sources*, not subject
    // identifiers — they must never become "Review domain footprint" pivots.
    const text = `
## Recommended Next Pivots
- Review domain footprint linkedin.com — fingerprinted on archived site
- Review domain footprint bizfileonline.sos.ca.gov — business registry source
- Review domain footprint opencorporates.com — registry source
- Review domain footprint ceroconstruction.com — subject's own domain
`;
    const pivots = extractRecommendedPivots(text);
    const values = pivots.map((p) => p.value);
    expect(values).toContain("ceroconstruction.com");
    expect(values).not.toContain("linkedin.com");
    expect(values).not.toContain("bizfileonline.sos.ca.gov");
    expect(values).not.toContain("opencorporates.com");
    expect(pivots).toHaveLength(1);
  });

  it("does not leak <think> reasoning blocks into pivot cards", () => {
    // Regression for the screenshot bug: the agent emitted a chain-of-thought
    // block inside the report text. The chat renderer strips it, but the Next
    // Steps parser used the raw text and turned reasoning lines into cards.
    const text = `
**Recommended next pivots:**
- Investigate sam.cole@example.com — same person
<think>
The detect_contradictions tool flagged 2 distinct names: Debra A. Cero vs Debra Cero.
Let me also call detect_contradictions to check for any issues.
</think>
- Corroborate the Oakley PO Box with county records
`;
    const pivots = extractRecommendedPivots(text);
    const serialized = JSON.stringify(pivots);
    expect(serialized).not.toContain("<think>");
    expect(serialized).not.toContain("</think>");
    expect(serialized).not.toContain("detect_contradictions");
    expect(serialized).not.toMatch(/Let me also call/i);
    // The two genuine pivots still come through.
    expect(pivots.map((p) => p.value)).toContain("sam.cole@example.com");
    expect(pivots.length).toBeGreaterThanOrEqual(2);
  });

  it("strips a surviving inline think fragment from an emitted field", () => {
    const text = `
## Recommended Next Pivots
- Investigate sam.cole@example.com — same person</think>
`;
    const pivots = extractRecommendedPivots(text);
    expect(JSON.stringify(pivots)).not.toContain("</think>");
  });

  it("ignores markdown table separator rows (no |---| pivots)", () => {
    // Regression: when the report renders pivots as a markdown table, the
    // separator row leaked through as a pivot with Target/Reason = "|---|---|---|".
    const text = `
## Recommended Next Pivots
| Action | Target | Type | Reason |
|---|---|---|---|
| Corroborate address | 526 Coconut Pl Brentwood CA | address | confirm ownership of record |
`;
    const pivots = extractRecommendedPivots(text);
    for (const p of pivots) {
      expect(p.value).not.toMatch(/^[\s|:_-]+$/);
      expect(p.prompt).not.toContain("|---|");
    }
    expect(pivots.some((p) => /^[\s|:_-]+$/.test(p.value))).toBe(false);
  });

  it("pivot prompt mandates recording findings (not just narrating the graph delta)", () => {
    // Regression: the old composer said "Return ... what changed in the case
    // graph", which made the agent NARRATE findings in chat and never call
    // record_artifacts → Evidence board stayed at 0 artifacts. The prompt must
    // instead require persistence before summarizing.
    const text = `
## Recommended Next Pivots
- Corroborate username pulsiveontop across platforms
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots.length).toBeGreaterThan(0);
    for (const p of pivots) {
      expect(p.prompt).toContain("record_artifacts");
      expect(p.prompt).not.toContain("what changed in the case graph");
    }
  });

  it("turns collision recommendations into safe review actions", () => {
    const text = `
## Recommended Next Pivots
- Review excluded collision Michael M Cero — likely namesake, not the same person
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots).toHaveLength(1);
    expect(pivots[0]).toMatchObject({
      actionLabel: "Review excluded collision",
      detail: "Michael M Cero · likely namesake, not the same person",
    });
  });

  it("parses Recommended Next Pivots from the recovered-run stub", () => {
    // cdf02ff8 Fix 4: recovery stub now emits a pivots section (kind-grouped
    // consider lines + concrete Investigate/Corroborate lines) so the Next
    // Steps rail is non-empty after a CPU-kill recovery.
    const recovered = [
      "## Findings report — recovered run",
      "",
      "The investigation for **jane@example.com** was interrupted before the agent could write its closing response. The saved evidence below was recovered from durable artifacts already written during the run.",
      "Last heartbeat: 2026-07-20T10:00:00.000Z.",
      "",
      "### Recovered findings",
      "| # | Kind | Value | Confidence | Source |",
      "|---:|---|---|---:|---|",
      "| 1 | email | jane@example.com | 90 | breach_check |",
      "| 2 | username | jdoe88 | 60 | username_sweep |",
      "",
      "Recovered 2 artifacts.",
      "",
      "## Recommended Next Pivots",
      "- Investigate jane@example.com — recovered email lead; Verifying email deliverability; Checking linked avatar data",
      "- Corroborate username jdoe88 across platforms — Checking developer profile traces; Reviewing community activity history",
      "- **email** — consider: Verifying email deliverability, Checking linked avatar data",
      "- **username** — consider: Checking developer profile traces, Building targeted search queries",
      "",
      "### Gaps",
      "- The run was closed by stale-run recovery, so this is not a full model-written synthesis.",
      "- Treat unresolved leads as pending until a follow-up run verifies them.",
    ].join("\n");
    const pivots = extractRecommendedPivots(recovered);
    expect(pivots.length).toBeGreaterThan(0);
    expect(pivots.map((p) => p.value)).toContain("jane@example.com");
    expect(pivots.some((p) => /jdoe88/i.test(p.value) || /jdoe88/i.test(p.label))).toBe(true);
  });

  describe("ids and dates are not phone pivots", () => {
    // Measured case (2026-09-24): a report linked an Apple Music track without
    // a scheme, and "Check phone association <track id>" was offered at HIGH
    // priority for the 10-digit catalogue id in the path. Values are synthetic.
    it("never takes a phone from inside a scheme-less link's path", () => {
      const text = `
## Recommended Next Pivots
- Review credit on music.apple.com/us/song/example-track/1234567890 — producer credit
- Review listing example.com/listing?id=4155550142 — marketplace listing
`;
      const pivots = extractRecommendedPivots(text);
      expect(pivots.some((p) => p.type === "phone")).toBe(false);
      expect(pivots.map((p) => p.value)).not.toContain("1234567890");
      expect(pivots.map((p) => p.value)).not.toContain("4155550142");
    });

    it("does not offer a bare id or a date as a phone pivot through the action-clause fallback", () => {
      const text = `
## Recommended Next Pivots
- Check track 1234567890 — Apple Music catalogue id
- Check 4155550142 — listing id
- Check 2023-02-02 — join date on the second account
`;
      expect(extractRecommendedPivots(text).some((p) => p.type === "phone")).toBe(false);
    });

    it("still extracts real phone numbers, including ones the old parser took", () => {
      const text = `
## Recommended Next Pivots
- Check phone 9165550142 — carrier lookup
- Check (916) 555-0199 — listing on business page
- Check 916-555-0123 listed on example.com/biz/some-shop
- Check +44 20 7946 0958 — UK landline in footer
- Check 020 7946 0958 — same line, national format
- Check 555-0142 — local number from the flyer
`;
      const phones = extractRecommendedPivots(text).filter((p) => p.type === "phone").map((p) => p.value);
      expect(phones).toEqual([
        "9165550142",
        "(916) 555-0199",
        "916-555-0123",
        "+44 20 7946 0958",
        "020 7946 0958",
        "555-0142",
      ]);
    });

    it("isPlausiblePhone: NANP shape, path tokens, dates and bare runs", () => {
      expect(isPlausiblePhone("925-642-7442", "Check 925-642-7442")).toBe(true);
      expect(isPlausiblePhone("1-925-642-7442", "Check 1-925-642-7442")).toBe(true);
      // area code starting 1 is not a NANP number
      expect(isPlausiblePhone("180-228-5951", "Check phone 180-228-5951")).toBe(false);
      // "+1" is NANP whatever follows it, so it is held to the NANP shape
      expect(isPlausiblePhone("+1 (916) 555-0199", "Check +1 (916) 555-0199")).toBe(true);
      expect(isPlausiblePhone("+11234567890", "Check phone +11234567890")).toBe(false);
      expect(isPlausiblePhone("+442079460958", "Check whatsapp +442079460958")).toBe(true);
      // inside a path or query
      expect(isPlausiblePhone("9165550142", "Check phone example.com/u/9165550142")).toBe(false);
      expect(isPlausiblePhone("9165550142", "Check phone https://x.test/?id=9165550142")).toBe(false);
      // dates
      expect(isPlausiblePhone("2023-02-02", "Check 2023-02-02")).toBe(false);
      expect(isPlausiblePhone("02/03/2023", "Check 02/03/2023")).toBe(false);
      // a bare run needs the line to say phone
      expect(isPlausiblePhone("9165550142", "Check 9165550142")).toBe(false);
      expect(isPlausiblePhone("9165550142", "Check mobile 9165550142")).toBe(true);
    });
  });

  // Shapes measured on a production report, 2026-09-25 (values synthetic).
  describe("report formatting is not pivot data", () => {
    const tableReport = `
## 10. Recommended Next Pivots

| Pivot | Rationale | Tool |
| --- | --- | --- |
| **Reverse phone lookup: +1-415-555-0142** | Would verify the breach phone independently | \`oathnet_lookup\` |
| **Breach-check on \`handle_one\` and \`handle_two\`** | Would reveal additional corpora | \`breach_check\` |

---

*Investigation conducted by the investigator. 23 artifacts recorded.*
`;

    it("never turns the table header row into a pivot", () => {
      const labels = extractRecommendedPivots(tableReport).map((p) => p.label);
      expect(labels.some((l) => /^Pivot\b/.test(l) || /Rationale/.test(l))).toBe(false);
    });

    it("reads a table row by cell: first cell is the pivot, second the reason", () => {
      const phone = extractRecommendedPivots(tableReport).find((p) => p.type === "phone");
      expect(phone).toBeDefined();
      expect(phone!.value.replace(/\D/g, "")).toBe("14155550142");
      expect(phone!.reason).toBe("Would verify the breach phone independently");
      expect(phone!.label).not.toMatch(/\|/);
      expect(phone!.label).not.toMatch(/oathnet_lookup/);
    });

    it("ends the section at a horizontal rule, so the report footer is never a pivot", () => {
      const labels = extractRecommendedPivots(tableReport).map((p) => p.label);
      expect(labels.some((l) => /Investigation conducted/.test(l))).toBe(false);
    });

    it("still skips a rule that comes before the first pivot", () => {
      const text = "**Recommended next pivots:**\n---\n- Investigate sam.cole@example.com — reuse check\n";
      expect(extractRecommendedPivots(text).map((p) => p.value)).toEqual(["sam.cole@example.com"]);
    });

    it("skips a whole-line italic note between pivots", () => {
      const text = "**Recommended next pivots:**\n- Investigate a@example.com — one\n*Note: breach values are masked.*\n- Investigate b@example.com — two\n";
      expect(extractRecommendedPivots(text).map((p) => p.value)).toEqual(["a@example.com", "b@example.com"]);
    });
  });
});

/**
 * Production 2026-10-01 (spearheadlab case; values below are synthetic). The
 * report hedged "may contain the student's university email (e.g., `…` or
 * `@…`)" and Next steps offered that GUESSED address as a HIGH "Verify email
 * ownership" card, backticks included, with a Run button.
 */
describe("examples and Markdown are never selectors", () => {
  const REPORT = `
**Recommended Next Pivots**
- Extract the thesis PDF (\`repo.example.edu/pub/tfg/2025/1234/...\`) — may contain the student's university email (e.g., \`jane.doe@uni.example\` or \`@campus.uni.example\`), advisor name, and acknowledgments.
- Breach check on \`contact@site.example\` — run \`rapidapi_breach_search\` on the contact email found on the site.
`;

  it("a guessed 'e.g.' address never becomes a pivot", () => {
    const pivots = extractRecommendedPivots(REPORT);
    expect(pivots.some((p) => p.value.includes("jane.doe"))).toBe(false);
    expect(pivots.some((p) => p.value.includes("campus.uni.example"))).toBe(false);
  });

  it("the host of a scheme-less URL is not offered as a domain to footprint", () => {
    const pivots = extractRecommendedPivots(REPORT);
    expect(pivots.some((p) => p.value === "repo.example.edu")).toBe(false);
  });

  it("a backticked real address is extracted clean, with an honest label", () => {
    const pivots = extractRecommendedPivots(REPORT);
    const email = pivots.find((p) => p.type === "email");
    expect(email).toMatchObject({ value: "contact@site.example", actionLabel: "Investigate email", priority: "high" });
    // Nothing that could get a Run button carries Markdown. The thesis line has
    // no observed selector left, so it falls back to its sentence — which the
    // shared shape table refuses, so the panel discloses it as "needs repair"
    // instead of offering it.
    for (const p of pivots) {
      const runnable = isWellFormedTarget(p.type as PivotTargetType, p.value);
      if (runnable) expect(p.value).not.toMatch(/[`'"]/);
    }
    const thesis = pivots.find((p) => p.label.startsWith("Extract the thesis PDF"));
    expect(thesis && isWellFormedTarget(thesis.type as PivotTargetType, thesis.value)).toBe(false);
  });

  it("unbracketed 'for example' / 'such as' clauses are examples too; 'i.e.' is not", () => {
    const text = `
## Recommended next pivots
- Try likely aliases, for example jdoe88@mail.example, against breach corpora
- Check likely handles such as @jdoe_88 on forums
- Investigate the registrant, i.e. owner@site.example — named in WHOIS
`;
    const values = extractRecommendedPivots(text).map((p) => p.value);
    expect(values).not.toContain("jdoe88@mail.example");
    expect(values).not.toContain("@jdoe_88");
    expect(values).toContain("owner@site.example");
  });

  it("an apostrophe inside an address is kept; quotes around it are not (Codex P1)", () => {
    const text = `
## Recommended next pivots
- Investigate o'connor@site.example — named on the contact page
- Investigate 'jane@uni.example' — quoted in the footer
`;
    const values = extractRecommendedPivots(text).map((p) => p.value);
    expect(values).toContain("o'connor@site.example");
    expect(values).not.toContain("connor@site.example");
    expect(values).toContain("jane@uni.example");
  });

  it("an example ends at its sentence; a real selector in the next one survives (Codex P2)", () => {
    const text = `
## Recommended next pivots
- Review naming patterns, e.g. first.last. Check observed@site.example — observed in WHOIS
`;
    expect(extractRecommendedPivots(text)[0]).toMatchObject({ value: "observed@site.example", type: "email" });
  });

  it("a capitalised marker is still an example", () => {
    const text = `
## Recommended next pivots
- Try the university format. E.g. jane.doe@uni.example might exist
- For example, guess@mail.example could be tried
`;
    const values = extractRecommendedPivots(text).map((p) => p.value);
    expect(values).not.toContain("jane.doe@uni.example");
    expect(values).not.toContain("guess@mail.example");
  });

  it("a bare domain still extracts when it is not a URL host", () => {
    const text = `
## Recommended next pivots
- Pivot on site.example — registrant overlap
`;
    expect(extractRecommendedPivots(text)[0]).toMatchObject({ value: "site.example", type: "domain" });
  });
});
