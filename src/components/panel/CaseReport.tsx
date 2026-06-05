import { useMemo } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  labelForArtifact,
  buildIdentityClusters,
  buildToolAudit,
  inferToolGaps,
  groupForKind,
  GROUP_LABEL,
  type ConfLabel,
} from "@/lib/intel";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Evidence-strength bucketing                                         */
/* ------------------------------------------------------------------ */

function statusOf(a: Artifact): string {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return String((m.status as string) ?? "new");
}
function bucket(a: Artifact): "confirmed" | "probable" | "lead" | "contradiction" | "excluded" {
  const c = a.confidence ?? 0;
  const st = statusOf(a);
  if (a.kind.toLowerCase() === "contradiction" || st === "contradicted") return "contradiction";
  if (st === "excluded" || a.kind.toLowerCase() === "excluded_collision") return "excluded";
  if (st === "verified" || c >= 90) return "confirmed";
  if (st === "probable" || c >= 75) return "probable";
  return "lead";
}

function ArtifactRow({ a }: { a: Artifact }) {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return (
    <tr className="border-t border-border-subtle align-top">
      <td className="px-3 py-2 text-muted-foreground text-[11px] uppercase tracking-wider">{a.kind}</td>
      <td className="px-3 py-2 font-mono break-all">{a.value}</td>
      <td className="px-3 py-2 text-[11px] text-muted-foreground">{a.source ?? "—"}</td>
      <td className="px-3 py-2 text-[11px]">{a.confidence ?? "—"}</td>
      <td className="px-3 py-2 text-[11px] text-muted-foreground">
        {String((m.reason_for_confidence as string) ?? "")}
        {m.reason_not_confirmed ? <div className="text-destructive/80">{String(m.reason_not_confirmed)}</div> : null}
      </td>
    </tr>
  );
}

function BucketTable({ rows, empty }: { rows: Artifact[]; empty: string }) {
  if (!rows.length) return <p className="text-muted-foreground italic text-[11px] mt-2">{empty}</p>;
  return (
    <div className="rounded-md border border-border-subtle overflow-hidden mt-2">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="bg-surface-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            <th className="text-left font-normal px-3 py-2 w-[110px]">Kind</th>
            <th className="text-left font-normal px-3 py-2">Value</th>
            <th className="text-left font-normal px-3 py-2 w-[140px]">Source</th>
            <th className="text-left font-normal px-3 py-2 w-[60px]">Conf.</th>
            <th className="text-left font-normal px-3 py-2">Reasoning</th>
          </tr>
        </thead>
        <tbody>{rows.map((a) => <ArtifactRow key={a.id} a={a} />)}</tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section header — red bar + ALL-CAPS spaced title, like the ref UI. */
/* ------------------------------------------------------------------ */
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mt-6 mb-3">
      <span className="w-[3px] h-4 bg-destructive rounded-sm" />
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-destructive">
        {children}
      </h3>
    </div>
  );
}

function HunterNote({ children }: { children: React.ReactNode }) {
  return (
    <aside className="my-3 pl-3 border-l-2 border-destructive/80 text-foreground/90 leading-relaxed">
      <div className="text-[10px] font-semibold tracking-[0.2em] uppercase text-destructive mb-1">
        Hunter's Note
      </div>
      <div className="text-[12px]">{children}</div>
    </aside>
  );
}

const CONF_PILL: Record<ConfLabel, string> = {
  CONFIRMED: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40",
  CORRELATED: "text-[hsl(var(--confidence-high))]/90 border-[hsl(var(--confidence-high))]/30",
  INFERRED: "text-primary border-primary/40",
  VERIFY: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40",
  CONFLICT: "text-destructive border-destructive/40",
  LOW: "text-muted-foreground border-border",
  FAILED: "text-destructive border-destructive/40 line-through",
};

// Map our internal labels to the reference vocabulary
const CONF_DISPLAY: Record<ConfLabel, string> = {
  CONFIRMED: "CONFIRMED",
  CORRELATED: "HIGH",
  INFERRED: "MEDIUM",
  VERIFY: "VERIFY",
  CONFLICT: "CONFLICT",
  LOW: "LOW",
  FAILED: "FAILED",
};

function ConfPill({ label }: { label: ConfLabel }) {
  return (
    <span
      className={cn(
        "inline-block px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider",
        CONF_PILL[label],
      )}
    >
      {CONF_DISPLAY[label]}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Derivations                                                         */
/* ------------------------------------------------------------------ */

type IdentityRow = { field: string; value: string; label: ConfLabel };

function pickBest(artifacts: Artifact[], kinds: string[]): Artifact | null {
  const pool = artifacts.filter((a) => kinds.includes(a.kind.toLowerCase()));
  if (!pool.length) return null;
  const rank: Record<ConfLabel, number> = {
    CONFIRMED: 6, CORRELATED: 5, INFERRED: 4, VERIFY: 3, LOW: 2, CONFLICT: 1, FAILED: 0,
  };
  return pool.slice().sort((a, b) => {
    const ra = rank[labelForArtifact(a)] ?? 0;
    const rb = rank[labelForArtifact(b)] ?? 0;
    if (ra !== rb) return rb - ra;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  })[0];
}

function pickAllEmails(artifacts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const a of artifacts.filter((x) => x.kind.toLowerCase() === "email")) {
    const k = a.value.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function buildIdentityRows(artifacts: Artifact[]): IdentityRow[] {
  const rows: IdentityRow[] = [];
  const name = pickBest(artifacts, ["name", "person"]);
  if (name) rows.push({ field: "Real name", value: name.value, label: labelForArtifact(name) });

  const dob = pickBest(artifacts, ["dob"]);
  if (dob) rows.push({ field: "Date of birth", value: dob.value, label: labelForArtifact(dob) });

  const age = pickBest(artifacts, ["age"]);
  if (age && !dob) rows.push({ field: "Age", value: age.value, label: labelForArtifact(age) });

  const phone = pickBest(artifacts, ["phone"]);
  if (phone) rows.push({ field: "Phone", value: phone.value, label: labelForArtifact(phone) });

  const region = pickBest(artifacts, ["location", "geo", "address"]);
  if (region) rows.push({ field: "Likely region", value: region.value, label: labelForArtifact(region) });

  const emails = pickAllEmails(artifacts);
  emails.forEach((e, i) => {
    rows.push({
      field: i === 0 ? "Primary email" : i === 1 ? "Alt email" : `Email ${i + 1}`,
      value: e.value,
      label: labelForArtifact(e),
    });
  });

  const gender = pickBest(artifacts, ["gender"]);
  if (gender) rows.push({ field: "Gender (implied)", value: gender.value, label: labelForArtifact(gender) });

  return rows;
}

type RegistrationRow = {
  site: string;
  identifier: string;
  source: string;
  label: ConfLabel;
};

function buildRegistrationRows(artifacts: Artifact[]): RegistrationRow[] {
  const rows: RegistrationRow[] = [];
  for (const a of artifacts) {
    const k = a.kind.toLowerCase();
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const site =
      (meta.site as string) ||
      (meta.platform as string) ||
      (meta.service as string) ||
      (meta.source_name as string) ||
      null;
    if (k === "breach") {
      rows.push({
        site: site || a.value,
        identifier:
          (meta.identifier as string) ||
          (meta.email as string) ||
          (meta.username as string) ||
          (meta.account as string) ||
          "—",
        source: a.source ?? "—",
        label: labelForArtifact(a),
      });
    } else if ((k === "account" || k === "social" || k === "handle") && site) {
      rows.push({
        site,
        identifier: a.value,
        source: a.source ?? "—",
        label: labelForArtifact(a),
      });
    }
  }
  // Dedupe by site|identifier
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.site.toLowerCase()}|${r.identifier.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type HunterNoteItem = { text: string };

function buildHunterNotes(artifacts: Artifact[], seedValue: string | null): HunterNoteItem[] {
  const notes: HunterNoteItem[] = [];
  const cluster = buildIdentityClusters(artifacts, seedValue);
  for (const w of cluster.warnings.slice(0, 3)) notes.push({ text: w });

  const breaches = artifacts.filter((a) => a.kind.toLowerCase() === "breach");
  const passwords = artifacts.filter((a) => a.kind.toLowerCase() === "password");
  if (breaches.length >= 3) {
    notes.push({
      text: `Subject appears in ${breaches.length} distinct breach corpora. Assume credential exposure is broad and that any reused password is in attacker hands.`,
    });
  }
  if (passwords.length >= 2) {
    const sample = passwords.slice(0, 3).map((p) => `\`${p.value}\``).join(", ");
    notes.push({
      text: `Password reuse pattern detected (${sample}). Treat any account secured by this family as compromised.`,
    });
  }

  const FIN = /(robinhood|coinbase|gatehub|kraken|gemini|binance|paypal|venmo|cashapp|wise|fidelity|schwab|chase|wells.?fargo|amex|amextax)/i;
  const financial = artifacts.filter((a) => FIN.test(a.value) || FIN.test(String(a.metadata?.site ?? "")));
  if (financial.length >= 2) {
    notes.push({
      text: `Multiple financial accounts tied to the same identity — credential-stuffing risk against either is high. Owner should be assumed at material financial risk.`,
    });
  }

  const hasName = artifacts.some((a) => ["name", "person"].includes(a.kind.toLowerCase()));
  const hasPhone = artifacts.some((a) => a.kind.toLowerCase() === "phone");
  const hasDob = artifacts.some((a) => a.kind.toLowerCase() === "dob");
  if (hasName && hasPhone && hasDob) {
    notes.push({
      text: `Full PII triad (name + phone + DOB) is present. This enables SIM-swap, voice-phishing, and KBA bypass against banks and brokers.`,
    });
  }

  return notes;
}

function buildUnknowns(artifacts: Artifact[]): string[] {
  const out: string[] = [];
  const groups = new Set(artifacts.map((a) => groupForKind(a.kind)));
  if (!artifacts.some((a) => a.kind.toLowerCase() === "address")) {
    out.push("No street address, city confirmation, or postal code recovered.");
  }
  if (!groups.has("social")) {
    out.push("No social media handles confirmed on live platforms.");
  }
  if (!artifacts.some((a) => a.kind.toLowerCase() === "ip")) {
    out.push("No device fingerprint, IP, or stealer-log presence observed.");
  }
  const hashes = artifacts.filter((a) => a.kind.toLowerCase() === "hash");
  if (hashes.length) {
    out.push(`${hashes.length} password hash${hashes.length === 1 ? "" : "es"} recovered but uncracked — plaintext unknown.`);
  }
  const audit = buildToolAudit(artifacts);
  const gaps = inferToolGaps(audit);
  for (const g of gaps.slice(0, 2)) {
    out.push(`Coverage gap on ${g.kind}: ${g.suggested.slice(0, 3).join(", ")} not yet attempted.`);
  }
  return out;
}

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

function computeRisk(artifacts: Artifact[]): { level: RiskLevel; risks: string[] } {
  const risks: string[] = [];
  let score = 0;

  const breaches = artifacts.filter((a) => a.kind.toLowerCase() === "breach").length;
  const passwords = artifacts.filter((a) => a.kind.toLowerCase() === "password").length;
  const hasName = artifacts.some((a) => ["name", "person"].includes(a.kind.toLowerCase()));
  const hasPhone = artifacts.some((a) => a.kind.toLowerCase() === "phone");
  const hasDob = artifacts.some((a) => a.kind.toLowerCase() === "dob");
  const FIN = /(robinhood|coinbase|gatehub|kraken|gemini|binance|paypal|venmo|cashapp|fidelity|schwab|chase|wells.?fargo|amex)/i;
  const ADULT = /(meetmindful|passionsnetwork|adultfriendfinder|ashleymadison|onlyfans|fansly)/i;

  const financial = artifacts.filter((a) => FIN.test(a.value) || FIN.test(String(a.metadata?.site ?? ""))).length;
  const adult = artifacts.filter((a) => ADULT.test(a.value) || ADULT.test(String(a.metadata?.site ?? ""))).length;

  if (breaches >= 1) score += 1;
  if (breaches >= 3) score += 1;
  if (passwords >= 1) score += 1;
  if (hasName && hasPhone && hasDob) score += 2;
  if (financial >= 2) score += 2;
  if (adult >= 1) score += 1;

  if (financial >= 2) {
    risks.push("Multiple financial accounts tied to the same identity — credential-stuffing exposure is plausible.");
  }
  if (hasName && hasPhone && hasDob) {
    risks.push("Full PII triad (name + phone + DOB) enables SIM-swap, voice-phishing, and KBA bypass on banks and brokers.");
  }
  if (adult >= 1) {
    risks.push("Sensitive-platform registrations create sextortion / outing leverage if combined with name and phone.");
  }
  if (passwords >= 2) {
    risks.push("Password reuse pattern detected — low password hygiene increases account-takeover risk across services.");
  }
  if (breaches >= 3) {
    risks.push(`Subject appears in ${breaches} breach corpora — assume broad credential exposure.`);
  }

  const level: RiskLevel =
    score >= 6 ? "CRITICAL" : score >= 4 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW";
  return { level, risks };
}

const RISK_COLOR: Record<RiskLevel, string> = {
  LOW: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/60",
  MEDIUM: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/60",
  HIGH: "text-[hsl(var(--warning))] border-[hsl(var(--warning))]/70",
  CRITICAL: "text-destructive border-destructive/70",
};

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export function CaseReport({
  seedValue,
  seedType,
  artifacts,
}: {
  seedValue: string | null;
  seedType: string | null;
  artifacts: Artifact[];
}) {
  const identity = useMemo(() => buildIdentityRows(artifacts), [artifacts]);
  const registrations = useMemo(() => buildRegistrationRows(artifacts), [artifacts]);
  const hunterNotes = useMemo(() => buildHunterNotes(artifacts, seedValue), [artifacts, seedValue]);
  const unknowns = useMemo(() => buildUnknowns(artifacts), [artifacts]);
  const risk = useMemo(() => computeRisk(artifacts), [artifacts]);

  const audit = buildToolAudit(artifacts);
  const confirmed = artifacts.filter((a) => labelForArtifact(a) === "CONFIRMED").length;

  // Evidence-strength buckets per the new audit rules.
  const buckets = useMemo(() => {
    const g: Record<string, Artifact[]> = { confirmed: [], probable: [], lead: [], contradiction: [], excluded: [] };
    for (const a of artifacts) g[bucket(a)].push(a);
    return g;
  }, [artifacts]);

  const safetyFlags = useMemo(
    () => artifacts.filter((a) => {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      return m.possible_minor === true || m.auto_pivot_blocked === true || statusOf(a) === "manual_review_required";
    }),
    [artifacts],
  );

  const nextPivots = useMemo(() => {
    const pivots: string[] = [];
    for (const a of [...buckets.probable, ...buckets.lead].slice(0, 8)) {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      const step = (m.next_verification_step as string) || "";
      if (step) pivots.push(`${a.kind}:${a.value} → ${step}`);
    }
    return pivots.slice(0, 6);
  }, [buckets]);

  return (
    <article id="case-report-print-root" className="text-[12.5px] leading-relaxed text-foreground/95">
      {/* Header */}
      <header className="space-y-1.5 border-b border-border-subtle pb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Case file
        </div>
        <h2 className="text-base font-display font-semibold break-all">
          {seedValue ?? "—"}
        </h2>
        <div className="flex flex-wrap gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <span className="px-1.5 py-0.5 border border-border rounded">{seedType ?? "unknown"}</span>
          <span className="px-1.5 py-0.5 border border-border rounded">{artifacts.length} artifacts</span>
          <span className="px-1.5 py-0.5 border border-border rounded">{audit.tools.length} tools</span>
          <span className="px-1.5 py-0.5 border border-border rounded">{buckets.confirmed.length} confirmed</span>
          <span className="px-1.5 py-0.5 border border-border rounded">{buckets.probable.length} probable</span>
          <span className="px-1.5 py-0.5 border border-border rounded">{buckets.lead.length} leads</span>
        </div>
      </header>

      {/* 1. Executive summary */}
      <SectionHeader>Executive Summary</SectionHeader>
      <p className="text-foreground/90">
        Investigation of <span className="font-mono">{seedValue ?? "—"}</span> produced{" "}
        {buckets.confirmed.length} confirmed, {buckets.probable.length} probable, and{" "}
        {buckets.lead.length} unverified leads. {buckets.contradiction.length} contradictions
        were detected. Source-based confidence caps are applied conservatively — breach-only
        evidence cannot exceed 65 without independent corroboration.
      </p>

      {/* 2. Safety / legal flags */}
      {safetyFlags.length > 0 && (
        <>
          <SectionHeader>Safety / Legal Flags</SectionHeader>
          <BucketTable rows={safetyFlags} empty="No safety flags." />
        </>
      )}

      {/* 3. Seed details */}
      <SectionHeader>Seed Details</SectionHeader>
      <div className="text-foreground/90 font-mono text-[12px]">
        {seedType ?? "unknown"} · {seedValue ?? "—"}
      </div>

      {/* 4. Confirmed findings */}
      <SectionHeader>Confirmed Findings</SectionHeader>
      <BucketTable rows={buckets.confirmed} empty="No findings meet the confirmation threshold (official + independent corroboration)." />

      {/* 5. Probable findings */}
      <SectionHeader>Probable Findings</SectionHeader>
      <BucketTable rows={buckets.probable} empty="No probable findings." />

      {/* 6. Leads requiring verification */}
      <SectionHeader>Leads Requiring Verification</SectionHeader>
      <BucketTable rows={buckets.lead.slice(0, 40)} empty="No outstanding leads." />

      {/* 7. Excluded / collision clusters */}
      {buckets.excluded.length > 0 && (
        <>
          <SectionHeader>Excluded / Collision Clusters</SectionHeader>
          <BucketTable rows={buckets.excluded} empty="—" />
        </>
      )}

      {/* 9. Contradictions */}
      {buckets.contradiction.length > 0 && (
        <>
          <SectionHeader>Contradictions &amp; Data Quality Problems</SectionHeader>
          <BucketTable rows={buckets.contradiction} empty="—" />
        </>
      )}

      {/* 14. Recommended next pivots */}
      {nextPivots.length > 0 && (
        <>
          <SectionHeader>Recommended Next Pivots</SectionHeader>
          <ul className="space-y-1.5 list-disc pl-5 text-foreground/90 font-mono text-[12px]">
            {nextPivots.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </>
      )}

      {/* Identity */}
      {identity.length > 0 && (
        <>
          <SectionHeader>Identity</SectionHeader>
          <div className="rounded-md border border-border-subtle overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-surface-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                  <th className="text-left font-normal px-3 py-2 w-[35%]">Field</th>
                  <th className="text-left font-normal px-3 py-2">Value</th>
                  <th className="text-left font-normal px-3 py-2 w-[110px]">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {identity.map((r, i) => (
                  <tr key={i} className="border-t border-border-subtle">
                    <td className="px-3 py-2 text-muted-foreground">{r.field}</td>
                    <td className="px-3 py-2 font-mono break-all">{r.value}</td>
                    <td className="px-3 py-2"><ConfPill label={r.label} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Hunter's notes (after identity, before registrations) */}
      {hunterNotes.slice(0, 2).map((n, i) => <HunterNote key={`hn-top-${i}`}>{n.text}</HunterNote>)}

      {/* Sensitive registrations */}
      {registrations.length > 0 && (
        <>
          <SectionHeader>Sensitive Registrations</SectionHeader>
          <div className="rounded-md border border-border-subtle overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-surface-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                  <th className="text-left font-normal px-3 py-2 w-[30%]">Site</th>
                  <th className="text-left font-normal px-3 py-2">Account identifier</th>
                  <th className="text-left font-normal px-3 py-2 w-[120px]">Source</th>
                  <th className="text-left font-normal px-3 py-2 w-[110px]">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r, i) => (
                  <tr key={i} className="border-t border-border-subtle align-top">
                    <td className="px-3 py-2">{r.site}</td>
                    <td className="px-3 py-2 font-mono break-all">{r.identifier}</td>
                    <td className="px-3 py-2 text-muted-foreground text-[11px]">{r.source}</td>
                    <td className="px-3 py-2"><ConfPill label={r.label} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Remaining hunter notes */}
      {hunterNotes.slice(2).map((n, i) => <HunterNote key={`hn-rest-${i}`}>{n.text}</HunterNote>)}

      {/* What we don't know */}
      {unknowns.length > 0 && (
        <>
          <SectionHeader>What We Don't Know</SectionHeader>
          <ul className="space-y-2 list-disc pl-5 text-foreground/90">
            {unknowns.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </>
      )}

      {/* Risk level */}
      <SectionHeader>Risk Level</SectionHeader>
      <div className={cn("rounded-md border-t-2 border border-border-subtle bg-surface-2 p-4", RISK_COLOR[risk.level])}>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-current" />
          <span className="px-2 py-0.5 rounded border border-current text-[11px] font-mono uppercase tracking-[0.2em]">
            {risk.level}
          </span>
        </div>
        <div className="mt-3 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Key risks
        </div>
        {risk.risks.length === 0 ? (
          <p className="mt-2 text-foreground/80">
            No elevated risk indicators detected from the current evidence.
          </p>
        ) : (
          <ul className="mt-2 space-y-2 list-disc pl-5 text-foreground/90">
            {risk.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </div>
    </article>
  );
}