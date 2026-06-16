---
version: alpha
name: Insight Finder
description: Calm, investigative, restrained accent. Cyber-tactical OSINT tool.
colors:
  background: "#070707"
  foreground: "#F8F8F8"
  card: "#141414"
  card-foreground: "#F8F8F8"
  popover: "#0F0F0F"
  popover-foreground: "#F8F8F8"
  primary: "#F3F3F3"
  primary-foreground: "#0C0C0C"
  primary-glow: "#FFFFFF"
  secondary: "#0F0F0F"
  secondary-foreground: "#F3F3F3"
  muted: "#0C0C0C"
  muted-foreground: "#B3B3B3"
  accent: "#F3F3F3"
  accent-foreground: "#0C0C0C"
  destructive: "#EF4343"
  destructive-foreground: "#FFFFFF"
  info: "#408EE8"
  success: "#50CE89"
  warning: "#F4B262"
  danger: "#EF4343"
  evidence: "#A3A3A3"
  info-muted: "#151E27"
  success-muted: "#14231C"
  warning-muted: "#251E12"
  danger-muted: "#2C1111"
  confidence-high: "#50CE89"
  confidence-high-glow: "#6CE5A2"
  confidence-mid: "#F4B262"
  confidence-low: "#F04D4D"
  highconf: "#50CE89"
  surface-0: "#070707"
  surface-1: "#0F0F0F"
  surface-2: "#141414"
  surface-3: "#1C1C1C"
  surface-4: "#232323"
  border: "#282828"
  border-subtle: "#191919"
  border-strong: "#3D3D3D"
  input: "#141414"
  ring: "#B8B8B8"
  intel-blue: "#4781F6"
  intel-violet: "#A463EE"
  brain-surface-base: "#0F0F0F"
  brain-card: "#141414"
  brain-border: "#232323"
  brain-text: "#EBEBEB"
  brain-muted: "#949494"
  brain-cyan: "#38D8FF"
  brain-status-ok: "#4FD382"
  brain-status-warn: "#F3B263"
  brain-status-bad: "#F15656"
  sidebar-background: "#070707"
  sidebar-foreground: "#B3B3B3"
  sidebar-primary: "#F3F3F3"
  sidebar-primary-foreground: "#0C0C0C"
  sidebar-accent: "#191919"
  sidebar-accent-foreground: "#F3F3F3"
  sidebar-border: "#191919"
  sidebar-ring: "#B8B8B8"
typography:
  sans:
    fontFamily: "Geist"
    fontSize: "16px"
  mono:
    fontFamily: "Geist Mono"
    fontSize: "14px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
components:
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.md}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    rounded: "{rounded.md}"
  badge-info:
    backgroundColor: "{colors.info}"
    textColor: "{colors.foreground}"
  badge-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.foreground}"
  badge-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.foreground}"
  badge-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.foreground}"
  badge-highconf:
    backgroundColor: "{colors.confidence-high}"
    textColor: "{colors.foreground}"
  badge-midconf:
    backgroundColor: "{colors.confidence-mid}"
    textColor: "{colors.foreground}"
  badge-lowconf:
    backgroundColor: "{colors.confidence-low}"
    textColor: "{colors.foreground}"
  badge-info-muted:
    backgroundColor: "{colors.info-muted}"
    textColor: "{colors.info}"
  badge-success-muted:
    backgroundColor: "{colors.success-muted}"
    textColor: "{colors.success}"
  badge-warning-muted:
    backgroundColor: "{colors.warning-muted}"
    textColor: "{colors.warning}"
  badge-danger-muted:
    backgroundColor: "{colors.danger-muted}"
    textColor: "{colors.danger}"
  sidebar:
    backgroundColor: "{colors.sidebar-background}"
    textColor: "{colors.sidebar-foreground}"
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
  brain-card:
    backgroundColor: "{colors.brain-card}"
    textColor: "{colors.brain-text}"
---

## Overview

Swarmbot design tokens — calm, investigative, restrained accent. Tiered near-black system (base / panel / card / interactive). Primary colors are near-white CTAs. Chromatic meaning is carried by danger (red) and confidence (green/amber).

## Colors

- **Background ({colors.background}):** Proximity neutral base.
- **Card ({colors.card}):** Elevated panel background.
- **Primary ({colors.primary}):** Near-white CTAs and active states.
- **Destructive ({colors.destructive}):** Proximity red for destructive actions.
- **Confidence High ({colors.confidence-high}):** Green for verified data.
- **Confidence Mid ({colors.confidence-mid}):** Amber for partial verification.
- **Confidence Low ({colors.confidence-low}):** Red for unverified data.

## Typography

Geist for sans-serif UI elements, Inter for chat, and Geist Mono for code/tactical data.

## Components

The UI relies heavily on cards, muted semantic backgrounds for tags, and strong destructive reds.
