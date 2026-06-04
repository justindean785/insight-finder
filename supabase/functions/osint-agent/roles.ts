// Investigator role labels used in system prompts.
// Internal-only — the UI does not surface these strings.

export const ROLES = {
  LEAD: "Lead Investigator",
  COLLECTOR: "Intelligence Collector",
  IDENTITY: "Identity Analyst",
  ATTRIBUTION: "Attribution Analyst",
  VERIFIER: "Evidence Verifier",
  NETWORK: "Network Analyst",
  CHRONOLOGY: "Chronology Analyst",
  HISTORIAN: "Case Historian",
  OFFICER: "Case Officer",
} as const;
