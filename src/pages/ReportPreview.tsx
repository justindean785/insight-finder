import { ReportCardV2, type Hypothesis } from "@/components/investigation/ReportCardV2";
import { lintReport, type ClusterAudit } from "@/lib/audit/confidence-linter";
import { checkIndependence, type Source } from "@/lib/audit/source-independence";

/**
 * Standalone preview at /report-preview — a FICTIONAL sample persona run through
 * the REAL audit pipeline (lintReport + checkIndependence), so the verdict, drift
 * arrow, and source-collapse reflect live findings, not hardcoded counts.
 * All names, addresses, emails and handles below are synthetic (no real person).
 * Used to A/B the accent (white/mono vs amber) before wiring into ReportTab.
 */

const clusters: ClusterAudit[] = [
  {
    name: "Cluster A — Jordan Vance",
    declaredTier: "High", // declared High; evidence averages to Medium → drift
    cells: [
      { claim: "Full Name", value: "JORDAN VANCE", source: "AcmeData breach", confidence: 80 },
      { claim: "Address", value: "742 Example Ave, Springfield IL 62704", source: "AcmeData breach", confidence: 55 },
      { claim: "Email link", value: "nightowl42@example.com", source: "AcmeData + ArchiveHub mirror", confidence: 60 },
      { claim: "Handle etymology", value: "'Night Owl' + 42", source: "PublicRoster / Wiki", confidence: 85 },
    ],
  },
];

const sources: Source[] = [
  { id: "S1", type: "breach", origin: "AcmeData-2019", url: "https://example.com/leak/x", retrievedAt: "2026-06-07T18:00:00Z", confidence: 80 },
  { id: "S2", type: "scribd", origin: "AcmeData-2019", url: "https://example.com/doc/mfb", retrievedAt: "2026-06-07T18:02:00Z", confidence: 60 },
  { id: "S3", type: "breach", origin: "PlayHub-2019", url: "https://example.com/leak/z", retrievedAt: "2026-06-07T18:05:00Z", confidence: 75 },
];

const hypotheses: Hypothesis[] = [
  { id: "H1", label: "Single owner — Jordan Vance", evidence: "AcmeData breach + ArchiveHub mirror both name Vance; handle matches public roster nickname", confidence: 55, distinguishingEvidence: "Independent primary source (court record, official roster, interview)" },
  { id: "H2", label: "Resold or shared mailbox", evidence: "altrunner88 ↔ 'Morgan Reed' conflict surfaces on the same email in PlayHub breach record", confidence: 35, distinguishingEvidence: "Login-IP geolocation + registration date vs. each breach date" },
  { id: "H3", label: "Account takeover at some point", evidence: "champ_alt identity ambiguity across platforms", confidence: 10, distinguishingEvidence: "Password reuse patterns; auth-event timeline" },
];

export default function ReportPreview() {
  // Live audit — drives verdict / drift / collapse, not static numbers.
  const confidenceFindings = lintReport(clusters);
  const independenceFindings = checkIndependence(sources);

  return (
    <div className="min-h-screen bg-background p-6 md:p-10">
      <div className="mx-auto max-w-5xl">
        <ReportCardV2
          seed={{ value: "nightowl42@example.com", type: "email" }}
          status="complete"
          cost={0.0594}
          caseId="CASE-7A3F2E91"
          analyst="JD"
          generatedAt="2026-06-07 18:30Z"
          clusters={clusters}
          sources={sources}
          confidenceFindings={confidenceFindings}
          independenceFindings={independenceFindings}
          hypotheses={hypotheses}
        />
      </div>
    </div>
  );
}
