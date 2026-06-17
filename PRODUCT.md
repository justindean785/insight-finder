# Product

## Register

product

## Users
OSINT investigators and analysts. They start from a single seed (email, username, phone, IP, domain, crypto wallet) and run an agentic investigation that orchestrates dozens of tools, records evidence with confidence + chain-of-custody, and separates identity clusters. Their context is focused, often long analytical sessions reviewing many artifacts, where the cost of a wrong merge (attributing two different people to one identity) is high. They need to trust, at a glance, what is *confirmed* versus a *lead*.

## Product Purpose
Insight Finder (Swarmbot) turns a seed into a tamper-evident investigation: an agent gathers and records artifacts, scores them by source class and confidence, surfaces contradictions and same-name collisions, and produces a chain-of-custody report. Success is measured by analyst trust — the interface must make evidence integrity legible (confirmed vs. lead, source, confidence, provenance) and must never make unverified data look confirmed.

## Brand Personality
Calm forensic precision. Trustworthy, legible, evidence-first, exact, restrained. Three words: **precise, trustworthy, calm.** The voice states what was found and from where; it never overclaims.

## Anti-references
- Flashy "hacker" dashboards: neon-green matrix rain, glitch effects, terminal-cosplay, skull iconography.
- Gradient-everything consumer SaaS; decorative glassmorphism for its own sake.
- Anything that renders a single-source lead with the same visual weight as a corroborated finding (the integrity failure mode).

## Design Principles
1. **Integrity is visible.** Confirmed vs. lead, source class, and confidence must read instantly — never color alone; pair with text/shape.
2. **Calm density.** Information-rich without noise. Restraint is the default; emphasis is earned by importance, not decoration.
3. **Earned familiarity.** Standard affordances (tabs, drawers, tables, command palette). The tool disappears into the task.
4. **Show provenance.** Every datum carries its source and confidence; nothing is asserted without where-it-came-from.
5. **Restraint over flash.** A monochrome forensic base; one restrained accent reserved for primary action and current selection only.

## Accessibility & Inclusion
- WCAG AA: body text ≥4.5:1; status never conveyed by color alone (tier badges pair color with label/icon).
- Full keyboard operation for tabs (roving tabindex), drawers, and the command palette; visible focus rings.
- `prefers-reduced-motion` honored on every transition (crossfade/instant fallback).
- Long sessions: avoid high-saturation surfaces and eye-strain contrast; dense but comfortable.
