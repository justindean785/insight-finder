/**
 * Tests for pivot loop gating rules
 * Deno test: deno test --allow-net pivot-loop/gating.test.ts
 */

import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { gateCandidate, scoreCandidate } from './gating.ts';
import { type PivotCandidate, type GatingScoringInput } from './types.ts';

function createCandidate(overrides: Partial<PivotCandidate>): PivotCandidate {
  return {
    id: 'test-' + Math.random().toString(36).slice(2),
    tool_name: 'test-tool',
    selector: 'test@example.com',
    objective: 'find related accounts',
    rationale: 'test rationale',
    information_gain: 0.5,
    source_independence: 0.5,
    collision_risk: 0.3,
    cost_estimate: 1.0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createInput(overrides: Partial<GatingScoringInput>): GatingScoringInput {
  return {
    candidate: createCandidate({}),
    excluded_selectors: new Map(),
    queried_selector_objectives: new Map(),
    previous_collision_decisions: new Map(),
    time_remaining_ms: 60000,
    active_clusters: [],
    active_contradictions: 0,
    ...overrides,
  };
}

Deno.test('Adult-related selector is NOT safety-excluded', () => {
  const candidate = createCandidate({
    selector: 'onlyfans.com/adultuser',
    objective: 'verify OnlyFans account ownership',
    information_gain: 0.5,
    source_independence: 0.5,
    collision_risk: 0.2,
  });

  const result = gateCandidate(createInput({ candidate }));

  // Should NOT be EXCLUDE_SAFETY; should proceed or hold
  assertEquals(result.decision !== 'EXCLUDE_SAFETY', true);
  // Verify the gate did not treat "adult" as a safety issue
  assertEquals(result.decision, 'PROCEED');
});

Deno.test('Bare person-name becomes HOLD_FOR_CORROBORATION, not EXCLUDE', () => {
  const candidate = createCandidate({
    tool_name: 'name_search',
    selector: 'john smith',
    information_gain: 0.5,
    source_independence: 0.5,
    collision_risk: 0.8, // High collision risk
  });

  const result = gateCandidate(createInput({ candidate }));

  // High collision risk bare name should HOLD, not EXCLUDE
  assertEquals(result.decision, 'HOLD_FOR_CORROBORATION');
  assertStringIncludes(result.gate_applied || '', 'COLLISION');
});

Deno.test('Bare admin/root username on social platform is eligible', () => {
  const candidate = createCandidate({
    tool_name: 'username_search',
    selector: 'admin',
    information_gain: 0.4,
    source_independence: 0.3,
    collision_risk: 0.2,
  });

  const result = gateCandidate(createInput({ candidate }));

  // Bare username should not be globally excluded (context-aware)
  assertEquals(result.decision !== 'EXCLUDE_NOISE', true);
});

Deno.test('System email noreply@ is excluded contextually', () => {
  const candidate = createCandidate({
    selector: 'noreply@company.com',
    tool_name: 'email_search',
  });

  const result = gateCandidate(createInput({ candidate }));

  // System email pattern should be EXCLUDE_NOISE
  assertEquals(result.decision, 'EXCLUDE_NOISE');
});

Deno.test('Premium tool on weak lead becomes HOLD, not PROCEED', () => {
  const candidate = createCandidate({
    tool_name: 'pdl_person_enrich',
    information_gain: 0.3, // Weak
    source_independence: 0.2, // Weak
    collision_risk: 0.7, // High
  });

  const result = gateCandidate(createInput({ candidate }));

  // Premium tool + weak lead should HOLD
  assertEquals(result.decision, 'HOLD_FOR_CORROBORATION');
});

Deno.test('Exact queried selector+objective is excluded', () => {
  const selector = 'john_doe@gmail.com';
  const objective = 'find related accounts';
  const candidate = createCandidate({
    selector,
    objective,
    tool_name: 'email_search',
  });

  const excluded = new Map();
  excluded.set(`email_search:${selector}`, { tool_name: 'email_search', selector, reason: 'queried' });

  const result = gateCandidate(createInput({ candidate, excluded_selectors: excluded }));

  // Exact duplicate should be EXCLUDE_QUERIED
  assertEquals(result.decision, 'EXCLUDE_QUERIED');
});

Deno.test('Credentials/secrets are safety-excluded', () => {
  const testCases = [
    'api_key=sk-1234567890',
    'password=MySecurePass123',
    'bearer_token=abc123',
    'ethereum_wallet=0xabc123',
  ];

  for (const selector of testCases) {
    const candidate = createCandidate({ selector });
    const result = gateCandidate(createInput({ candidate }));

    // All should be EXCLUDE_SAFETY
    assertEquals(result.decision, 'EXCLUDE_SAFETY', `Failed for: ${selector}`);
  }
});

Deno.test('Score calculation is non-negative', () => {
  const candidates = [
    createCandidate({ information_gain: 0, source_independence: 0, collision_risk: 1 }),
    createCandidate({ information_gain: 1, source_independence: 1, collision_risk: 0 }),
    createCandidate({ information_gain: 0.5, source_independence: 0.5, collision_risk: 0.5 }),
  ];

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate);
    assertEquals(score >= 0, true, `Score should be non-negative, got ${score}`);
  }
});
