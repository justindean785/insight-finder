/**
 * A synthetic "handle-seed" case shaped like the 2026-09-02 production export
 * that motivated the report-truth fixes — every VALUE here is invented
 * (reserved documentation ranges, `.example` / `.invalid` names, made-up
 * handles). What is real is the SHAPE:
 *
 *   - alias twins: the same selector recorded as `ip_address` and `ip`, and as
 *     `url` and `social_profile`, at different confidences;
 *   - a contradiction record from the collision detector filed as an artifact;
 *   - an organisation, an event, a weak lead, a social account and a registry
 *     record — kinds the report used to file under **Other**;
 *   - six spellings of one tool's source string;
 *   - an identity cluster whose members never exceed 70 effective confidence
 *     (one member is STORED at 95 but server-capped at 70), sharing an email so
 *     the merge bonus alone would lift the headline into the 90s;
 *   - one analyst Confirm, one Dismiss on ONE twin of a pair;
 *   - zero `kind = "finding"` rows, so the engine adjudicated nothing.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { AuthoritativeFindings } from "@/lib/authoritative-findings";

export const HANDLE_SEED = "@qa_nightjar";
export const HANDLE_EMAIL = "qa_nightjar@example.invalid";
export const TWIN_IP = "203.0.113.57";
export const TWIN_URL = "https://social.example/qa_nightjar";
export const CONTRADICTION_VALUE = `email:${HANDLE_EMAIL}`;
export const ORG_VALUE = "Nightjar Media LLC";
export const EVENT_VALUE = "Nightjar Fight League — listed participant";
export const WEAK_LEAD_VALUE = "Sierra — mentioned in a stream title";
export const SOCIAL_ACCOUNT_VALUE = "nitro_cam_qa";
export const LEGAL_RECORD_VALUE = "Example State Registry — Nightjar, Q. A. (DOB 1/1/1990)";

let n = 0;
const t = () => `2026-09-02T14:${String(30 + (n++ % 29)).padStart(2, "0")}:00.000Z`;

function art(p: Partial<Artifact> & { id: string; kind: string; value: string }): Artifact {
  return {
    source: null,
    confidence: 50,
    created_at: t(),
    metadata: {},
    ...p,
  } as Artifact;
}

export const SWEEP_SOURCE_SPELLINGS = [
  "username_sweep",
  "username_sweep analysis",
  "Username_Sweep/Instagram",
  "username_sweep (7 platforms)",
  "username_sweep + minimax_web_search",
  "USERNAME_SWEEP",
];

export function handleCaseArtifacts(): Artifact[] {
  n = 0;
  return [
    // seed
    art({ id: "seed", kind: "username", value: "qa_nightjar", source: "seed", confidence: 50, metadata: { platforms: ["Instagram", "YouTube"], confidence_cap_applied: 50 } }),

    // alias twins — ip_address / ip
    art({ id: "twin-ip-a", kind: "ip_address", value: TWIN_IP, source: "oathnet_lookup", confidence: 40, metadata: { confidence_cap_applied: 60, source_category: ["breach"] } }),
    art({ id: "twin-ip-b", kind: "ip", value: TWIN_IP, source: "ip_intel + shodan_internetdb", confidence: 70, metadata: { confidence_cap_applied: 70, source_category: ["infra"] } }),
    // alias twins — url / social_profile
    art({ id: "twin-url-a", kind: "url", value: TWIN_URL, source: "username_sweep", confidence: 30, metadata: { confidence_cap_applied: 45 } }),
    art({ id: "twin-url-b", kind: "social_profile", value: TWIN_URL, source: "gemini_deep_dork", confidence: 55, metadata: { handle: "qa_nightjar", platform: "Social", confidence_cap_applied: 55 } }),

    // rows the report filed under **Other**
    art({ id: "contra", kind: "contradiction", value: CONTRADICTION_VALUE, source: "collision_detector", confidence: 40, metadata: { conflict: true, severity: "high", collision_kind: "email" } }),
    art({ id: "org", kind: "organization", value: ORG_VALUE, source: "opencorporates + exa_search", confidence: 62, metadata: { source_category: ["official", "independent_public"] } }),
    art({ id: "event", kind: "event", value: EVENT_VALUE, source: "gemini_deep_dork", confidence: 55, metadata: { confidence_cap_applied: 55 } }),
    art({ id: "weak", kind: "weak_lead", value: WEAK_LEAD_VALUE, source: "socialfetch_web_read", confidence: 20, metadata: {} }),
    art({ id: "soc", kind: "social_account", value: SOCIAL_ACCOUNT_VALUE, source: "socialfetch_lookup", confidence: 40, metadata: { platform: "Instagram", confidence_cap_applied: 40 } }),
    art({ id: "legal", kind: "legal_record", value: LEGAL_RECORD_VALUE, source: "exa_search + jina_reader_scrape", confidence: 25, metadata: { confidence_cap_applied: 85 } }),

    // six spellings of one tool
    ...SWEEP_SOURCE_SPELLINGS.map((source, i) =>
      art({ id: `sweep-${i}`, kind: "social_profile", value: `https://site${i}.example/qa_nightjar`, source, confidence: 45, metadata: { handle: "qa_nightjar", platform: `Site${i}`, confidence_cap_applied: 45 } })),

    // identity cluster — EMAIL_MATCH across four rows, members capped at 70
    art({ id: "cl-email", kind: "email", value: HANDLE_EMAIL, source: "hunter_email_verifier + rapidapi_breach_search", confidence: 55, metadata: { confidence_cap_applied: 65, source_category: ["breach"] } }),
    art({ id: "cl-breach-1", kind: "breach_exposure", value: `Breach exposure: ${HANDLE_EMAIL} (hibp_style)`, source: "rapidapi_breach_search", confidence: 55, metadata: { email: HANDLE_EMAIL, confidence_cap_applied: 60 } }),
    art({ id: "cl-breach-2", kind: "breach_exposure", value: `Breach exposure: ${HANDLE_EMAIL} (leakcheck_lookup)`, source: "leakcheck_lookup", confidence: 55, metadata: { email: HANDLE_EMAIL, confidence_cap_applied: 60 } }),
    // stored 95, server-capped at 70 — the raw column must not reach the headline
    art({ id: "cl-name", kind: "name", value: "Q. A. Nightjar", source: "oathnet_lookup", confidence: 95, metadata: { email: HANDLE_EMAIL, confidence_cap_applied: 70 } }),
  ];
}

export const HANDLE_CASE_REVIEWS: Record<string, "confirmed" | "dismissed"> = {
  "cl-email": "confirmed",
  "twin-ip-a": "dismissed",
};

export function handleCaseAuthority(total: number): AuthoritativeFindings {
  return { state: "complete", findings: [], rejectedCount: 0, totalArtifacts: total };
}
