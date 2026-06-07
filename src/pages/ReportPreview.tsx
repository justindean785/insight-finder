import { ReportCardV2, type Hypothesis } from "@/components/investigation/ReportCardV2";
import { lintReport, type ClusterAudit } from "@/lib/audit/confidence-linter";
import { checkIndependence, type Source } from "@/lib/audit/source-independence";

/**
 * Standalone preview at /report-preview — Broner sample data run through the
 * REAL audit pipeline (lintReport + checkIndependence), so the verdict, drift
 * arrow, and source-collapse reflect live findings, not hardcoded counts.
 * Used to A/B the accent (white/mono vs amber) before wiring into ReportTab.
 */

const clusters: ClusterAudit[] = [
  {
    name: "Cluster A — Adrien Broner",
    declaredTier: "High", // declared High; evidence averages to Medium → drift
    cells: [
      { claim: "Full Name", value: "ADRIEN BRONER", source: "MyDriveSure breach", confidence: 80 },
      { claim: "Address", value: "2480 Scully St, Cincinnati OH 45214", source: "MyDriveSure breach", confidence: 55 },
      { claim: "Email link", value: "theproblem20@gmail.com", source: "MyDriveSure + Scribd mirror", confidence: 60 },
      { claim: "Handle etymology", value: "'The Problem' + 20", source: "BoxRec / Wikipedia", confidence: 85 },
    ],
  },
];

const sources: Source[] = [
  { id: "S1", type: "breach", origin: "MyDriveSure-2019", url: "https://leakcheck.io/x", retrievedAt: "2026-06-07T18:00:00Z", confidence: 80 },
  { id: "S2", type: "scribd", origin: "MyDriveSure-2019", url: "https://scribd.com/doc/mfb", retrievedAt: "2026-06-07T18:02:00Z", confidence: 60 },
  { id: "S3", type: "breach", origin: "Zynga-2019", url: "https://leakcheck.io/z", retrievedAt: "2026-06-07T18:05:00Z", confidence: 75 },
];

const hypotheses: Hypothesis[] = [
  { id: "H1", label: "Single owner — Adrien Broner", evidence: "MyDriveSure breach + Scribd mirror both name Broner; handle matches boxing nickname", confidence: 55, distinguishingEvidence: "Independent primary source (court record, official roster, interview)" },
  { id: "H2", label: "Resold or shared Gmail", evidence: "aajj1989 ↔ Amit Jain conflict surfaces on the same email in Zynga breach record", confidence: 35, distinguishingEvidence: "Login-IP geolocation + registration date vs. each breach date" },
  { id: "H3", label: "Account takeover at some point", evidence: "wbochamp identity ambiguity across platforms", confidence: 10, distinguishingEvidence: "Password reuse patterns; auth-event timeline" },
];

export default function ReportPreview() {
  // Live audit — drives verdict / drift / collapse, not static numbers.
  const confidenceFindings = lintReport(clusters);
  const independenceFindings = checkIndependence(sources);

  return (
    <div className="min-h-screen bg-background p-6 md:p-10">
      <div className="mx-auto max-w-5xl">
        <ReportCardV2
          seed={{ value: "theproblem20@gmail.com", type: "email" }}
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
