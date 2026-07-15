/**
 * Pivot Gating and Scoring Logic
 * Deterministic rules for accept/hold/exclude decisions on pivot candidates
 */

import { type PivotCandidate, type GatingScoringInput, type GatingResult } from './types.ts';

// Thresholds for gating decisions
const GATING_CONFIG = {
  INFORMATION_GAIN_MIN: 0.15, // minimum information gain to proceed
  SOURCE_INDEPENDENCE_MIN: 0.2, // minimum source independence
  COLLISION_RISK_MAX: 0.7, // maximum acceptable collision risk
  COST_MULTIPLIER_MAX: 3.0, // max time multiple vs baseline
};

/**
 * Compute a composite score for a candidate
 * Higher score = more valuable investigation
 *
 * Score = information_gain * (1 + source_independence) * (1 - collision_risk) / cost
 */
export function scoreCandidate(candidate: PivotCandidate): number {
  const igain = Math.max(0, candidate.information_gain);
  const srcind = Math.max(0, candidate.source_independence);
  const crisk = Math.max(0, Math.min(1, candidate.collision_risk));
  const cost = Math.max(1, candidate.cost_estimate);

  return (igain * (1 + srcind) * (1 - crisk)) / cost;
}

/**
 * Apply deterministic gating rules in order
 *
 * Rules are applied in sequence; first match wins. This ensures consistent,
 * auditable decisions that can be explained to the user.
 */
export function gateCandidate(input: GatingScoringInput): GatingResult {
  const { candidate, excluded_selectors, queried_selector_objectives, time_remaining_ms } = input;

  // 1. EXCLUDE_QUERIED: exact tool+selector+objective already tried
  const selectorKey = `${candidate.tool_name}:${candidate.selector}`;
  if (excluded_selectors.has(selectorKey)) {
    const reason = `Selector already queried or excluded: ${candidate.tool_name}(${candidate.selector})`;
    return {
      decision: 'EXCLUDE_QUERIED',
      score: 0,
      gate_applied: 'EXCLUDE_QUERIED',
      rationale: reason,
    };
  }

  // 2. EXCLUDE_SAFETY: known safety concerns
  if (isSafetyRejectable(candidate.selector)) {
    return {
      decision: 'EXCLUDE_SAFETY',
      score: 0,
      gate_applied: 'EXCLUDE_SAFETY',
      rationale: `Selector rejected: contains secrets, credentials, or adult-platform risk`,
    };
  }

  // 3. HOLD_FOR_CORROBORATION: high collision risk bare name (valid seed, needs corroboration)
  if (isCollisionRisk(candidate)) {
    return {
      decision: 'HOLD_FOR_CORROBORATION',
      score: scoreCandidate(candidate),
      gate_applied: 'COLLISION_HOLD',
      rationale: `High collision risk: bare name query without location/email/date scope. Hold for corroboration or user approval.`,
    };
  }

  // 4. EXCLUDE_NOISE: selector is known generic infrastructure
  if (isGenericInfrastructure(candidate.selector)) {
    return {
      decision: 'EXCLUDE_NOISE',
      score: 0,
      gate_applied: 'EXCLUDE_NOISE',
      rationale: `Selector matches known generic infrastructure (e.g., 'admin', 'root')`,
    };
  }

  // 5. HOLD_FOR_CORROBORATION: premium tool on weak lead
  if (isPremiumToolWeakLead(candidate)) {
    return {
      decision: 'HOLD_FOR_CORROBORATION',
      score: scoreCandidate(candidate),
      gate_applied: 'HOLD_FOR_CORROBORATION',
      rationale: `Premium tool (${candidate.tool_name}) on weak lead; hold for corroboration before executing`,
    };
  }

  // 6. HOLD_FOR_CORROBORATION: selector previously excluded for corroboration
  if (excluded_selectors.has(selectorKey)) {
    return {
      decision: 'HOLD_FOR_CORROBORATION',
      score: scoreCandidate(candidate),
      gate_applied: 'HOLD_FOR_CORROBORATION',
      rationale: `Selector previously held for corroboration; ready for escalation if evidence gathered`,
    };
  }

  // 7. DEFER: low information gain but alternatives exist
  const score = scoreCandidate(candidate);
  if (score < GATING_CONFIG.INFORMATION_GAIN_MIN) {
    return {
      decision: 'DEFER',
      score: score,
      gate_applied: 'LOW_SCORE',
      rationale: `Score ${score.toFixed(2)} below threshold ${GATING_CONFIG.INFORMATION_GAIN_MIN}; defer for now`,
    };
  }

  // 8. PROCEED: all gates pass
  return {
    decision: 'PROCEED',
    score: score,
    rationale: `Score ${score.toFixed(2)}: information_gain=${candidate.information_gain.toFixed(2)}, source_independence=${candidate.source_independence.toFixed(2)}, collision_risk=${candidate.collision_risk.toFixed(2)}`,
  };
}

/**
 * Safety check: reject selectors with known security red flags
 * NOTE: This gate applies ONLY to credential/secret patterns.
 * Adult subject matter is NOT automatically unsafe or prohibited.
 * Preserve existing minor-safety rules (handled elsewhere by policy).
 */
function isSafetyRejectable(selector: string): boolean {
  // Patterns that suggest secrets or credentials (not content-based)
  const safetyPatterns = [
    /password|pwd|secret|token|key|api[_-]?key|private[_-]?key|api[_-]?secret/i,
    /bearer|authorization|oauth|jwt|credential/i,
    /ssn|social[_-]?security|credit[_-]?card|cvv|pin/i,
    /ethereum|bitcoin|crypto|wallet|seed[_-]?phrase/i,
  ];

  return safetyPatterns.some(pattern => pattern.test(selector));
}

/**
 * High collision risk: bare person-name queries without scoping anchor
 * NOTE: A bare name is a VALID investigation seed.
 * This gate identifies HIGH collision risk that warrants HOLD_FOR_CORROBORATION,
 * not automatic exclusion. User must opt-in or corroboration must be gathered first.
 */
function isCollisionRisk(candidate: PivotCandidate): boolean {
  // If explicitly scored as low collision risk, pass
  if (candidate.collision_risk < 0.3) return false;

  // Tools that are prone to collision without context
  const collisionProneTools = [
    'username_search',
    'name_search',
    'social_media_search',
    'generic_person_finder',
  ];

  if (!collisionProneTools.includes(candidate.tool_name)) return false;

  // Check if selector looks like a bare name (no email, no location, no date anchor)
  const hasContext =
    /@/.test(candidate.selector) || // email
    /\b(uk|us|canada|australia|london|new york|us|uk|usa)\b/i.test(candidate.selector) || // location
    /\b(19|20)\d{2}\b/.test(candidate.selector); // year/date

  // Return true = HIGH collision risk (should trigger HOLD, not EXCLUDE)
  return !hasContext && candidate.collision_risk > 0.6;
}

/**
 * Noise check: known generic infrastructure handles
 * NOTE: Context matters. "admin" or "root" may be valid usernames in a specific investigation.
 * Only EXCLUDE when the selector clearly indicates infrastructure (e.g., system service accounts).
 * Bare handles like "admin" on a social platform should NOT be excluded.
 */
function isGenericInfrastructure(selector: string): boolean {
  // Only reject system/infrastructure-specific patterns
  // Pattern: handle@internal.domain OR handle@localhost OR obvious service account emails
  const infraPatterns = [
    /admin@(internal|localhost|127\.0\.0\.1|\.local|\.internal)/i,
    /root@(internal|localhost|127\.0\.0\.1|\.local|\.internal)/i,
    /^(noreply|no-?reply|service|system|bot|api|app)@/i, // system account emails
    /^webmaster@/i,
    /^postmaster@/i,
  ];

  return infraPatterns.some(pattern => pattern.test(selector));
}

/**
 * Premium tool + weak lead = hold for corroboration
 */
function isPremiumToolWeakLead(candidate: PivotCandidate): boolean {
  // Tools that are expensive or require corroboration
  const premiumTools = ['pdl_person_enrich', 'clearbit_search', 'apollo_search'];

  if (!premiumTools.includes(candidate.tool_name)) return false;

  // Weak lead: low information gain and high collision risk
  return (
    candidate.information_gain < 0.4 &&
    candidate.source_independence < 0.5 &&
    candidate.collision_risk > 0.5
  );
}

/**
 * Rank candidates by score (highest first)
 */
export function rankCandidates(candidates: PivotCandidate[]): PivotCandidate[] {
  return candidates
    .map(c => ({ ...c, _score: scoreCandidate(c) }))
    .sort((a, b) => (b._score as number) - (a._score as number))
    .map(c => {
      const { _score, ...rest } = c;
      return rest as PivotCandidate;
    });
}

/**
 * Validate a plan before execution
 * (secondary check after all items have been gated)
 */
export function validatePlan(plan: {
  plan_items: { decision: string; candidate: PivotCandidate }[];
}): string[] {
  const errors: string[] = [];
  const proceedSelectors = new Set<string>();

  for (const item of plan.plan_items) {
    if (item.decision === 'PROCEED') {
      const key = `${item.candidate.tool_name}:${item.candidate.selector}`;
      if (proceedSelectors.has(key)) {
        errors.push(`Duplicate PROCEED decision for ${key}`);
      }
      proceedSelectors.add(key);

      // Sanity check: PROCEED items should have reasonable scores
      const score = scoreCandidate(item.candidate);
      if (score < 0.01) {
        errors.push(`PROCEED item ${key} has suspiciously low score ${score}`);
      }
    }
  }

  return errors;
}
