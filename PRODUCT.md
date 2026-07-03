# Product

## Register

product

## Users

OSINT analysts, investigators, researchers, and evidence reviewers working active cases in a high-density workstation. They need to launch investigations quickly, inspect provider output, preserve evidence context, and separate verified facts from weak leads.

## Product Purpose

Swarmbot (Insight Finder) is an investigative dashboard for starting, routing, reviewing, and reporting public-source intelligence workflows. Success means a user can enter a seed, understand what the agent is doing, review sourced artifacts with confidence tiers, and move from intake to evidence to report without losing chain-of-custody context. Success is measured by analyst trust: the interface must make evidence integrity legible — confirmed vs. lead, source, confidence, provenance — and must never make unverified data look confirmed.

## Brand Personality

Forensic instrument panel, not hacker movie prop. Three words: **precise, trustworthy, calm.** The interface is a working analyst console: dense, glass-surfaced, quietly high-production — the kind of tool a real intelligence unit would trust, not the kind Hollywood invents for one. Glass panels, blur, and monospace forensic chrome are the deliberate visual identity here (see Glass/Forensic System below), not defaults to avoid. What's restrained is *how* those materials are used, not whether they're used at all.

## Anti-references

What we're explicitly not:
- Generic SaaS dashboards (gradient hero metrics, identical card grids, purple-glow marketing shells).
- Hollywood hacker cliché: neon-green matrix rain, glitch effects, scanline overlays, skull iconography, decorative "typing" animations.
- Glass/glow used as generic decoration rather than a deliberate material with a budget (see below) — the tell that separates "designed forensic console" from "AI slop wearing a dark theme."
- Anything that renders a single-source lead with the same visual weight as a corroborated finding (the integrity failure mode).

## Glass/Forensic System

The glass-surfaced, blurred, monospace-accented forensic look is intentional and load-bearing for this product's identity. It reads as professional, not campy, only when it follows a budget:

- **Blur has a budget.** Backdrop blur marks *elevation* (a panel is floating above the base layer), not "every surface gets glass." One blur intensity per elevation tier (e.g. base panel vs. modal/overlay); don't stack escalating blur values ad hoc per component.
- **Glow is state, not decoration.** A glow or halo must map to something real: active selection, live/streaming status, confidence tier, error. A glow with no state behind it (a static accent dot that glows for no reason, a hover shine with no functional meaning) is the amateur tell — cut it.
- **No side-stripe borders as accents.** `border-left`/`border-right` as a colored indicator strip is a generic-template tell, not forensic precision. Use a full border, a background tint, or a leading icon/dot instead.
- **No scanline/matrix/glitch motifs.** Decorative dotted-grid or radial-dot "neural network" backgrounds are borderline — fine as a rare, single accent tied to an actual data-relationship view (e.g. an identity graph), never as generic panel wallpaper.
- **Monospace is a data face, not a body face.** Reserve monospace (Geist Mono or equivalent) for actual data: IDs, timestamps, code/JSON, coordinates, hashes. Labels and prose stay in the primary sans so the console doesn't read as terminal cosplay.
- **Contrast discipline survives the glass.** Text over a blurred/tinted surface must still hit WCAG AA (4.5:1 body, 3:1 large). Opacity-reduced text stacked on top of blur is the most common way this silently fails — check the compounded result, not each layer in isolation.
- **Every glass/forensic surface still needs full interaction states.** Hover, focus-visible, active, disabled — custom chip/badge/tile components built from raw CSS (not the shared component library) are the most common place these get skipped. If a component is interactive, it gets a visible keyboard focus ring, full stop.
- **Micro-type has a floor.** Dense forensic labels can run smaller than body text, but not below ~10px, and not combined with both heavy letter-spacing *and* reduced opacity — pick at most one intensifier alongside the small size.

## Design Principles

- Evidence first: source, confidence, custody, and status must be more prominent than decoration.
- Dense but legible: preserve workstation density while keeping text contrast, focus states, and tap targets usable.
- State over style: accent color, glow, and blur elevation all indicate selection, action, confidence, warning, or failure — never pure decoration.
- Analyst control: actions should be explicit, reversible where practical, and clear about what will happen.
- No false certainty: UI copy must separate facts, assumptions, weak leads, and failures.

## Accessibility & Inclusion

Target WCAG AA for text, controls, placeholders, focus indicators, and keyboard navigation — including text and focus rings rendered over glass/blur surfaces. Support reduced motion. Do not rely on color alone for status. Minimize PII exposure in client-side UI logs and browser-visible diagnostics.
