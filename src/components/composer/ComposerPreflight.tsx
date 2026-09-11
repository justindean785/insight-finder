import { useId } from "react";
import { ChevronDown, Crosshair, SlidersHorizontal, Link2, Mail, Phone, Globe, Network, User, Hash, MapPin, FileSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SeedKind } from "@/lib/seed";
import {
  DEFAULT_CONTROLS,
  DEPTH_LABEL,
  EVIDENCE_STANDARD,
  KIND_LABEL,
  SCOPE_LABEL,
  type DepthPreset,
  type PreflightControls,
  type PreflightResult,
  type ScopePreset,
} from "@/lib/composer-preflight";

const KIND_ICON: Record<SeedKind, typeof Globe> = {
  email: Mail, username: User, phone: Phone, ip: Network, domain: Globe,
  url: Link2, crypto: Hash, address: MapPin, other: FileSearch,
};

const KIND_OPTIONS: SeedKind[] = ["email", "username", "phone", "ip", "domain", "url", "crypto", "address", "other"];

/**
 * The parsed target, shown before anything is sent: what the request will
 * investigate and as what. The type is correctable — a native select, so it
 * is keyboard- and screen-reader-operable with no custom widget.
 */
export function TargetChip({
  result,
  kindOverride,
  onKindChange,
}: {
  result: PreflightResult;
  kindOverride: SeedKind | null;
  onKindChange: (kind: SeedKind | null) => void;
}) {
  const selectId = useId();
  const target = result.target;
  if (!target) return null;
  const Icon = target.freeText ? Crosshair : KIND_ICON[target.kind] ?? FileSearch;
  return (
    <div
      className={cn(
        "inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border pl-2 pr-1 text-data",
        result.errors.target ? "border-[hsl(var(--danger)/0.5)] text-[hsl(var(--danger))]" : "border-white/[0.09] bg-white/[0.03] text-foreground/90",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate font-mono" title={target.value}>{target.value}</span>
      <label htmlFor={selectId} className="sr-only">Target type</label>
      <div className="relative shrink-0">
        <select
          id={selectId}
          value={kindOverride ?? (target.freeText ? "other" : target.kind)}
          onChange={(e) => {
            const v = e.target.value as SeedKind;
            onKindChange(v === (target.freeText ? "other" : target.kind) && !kindOverride ? null : v);
          }}
          className="h-6 appearance-none rounded bg-white/[0.05] py-0 pl-1.5 pr-5 text-micro text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>{k === "other" ? "Free text" : KIND_LABEL[k]}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
      </div>
    </div>
  );
}

/** Scope & controls — the optional structure around the free-form request. */
export function ScopeControls({
  controls,
  onChange,
  result,
  objectiveErrorId,
}: {
  controls: PreflightControls;
  onChange: (next: PreflightControls) => void;
  result: PreflightResult;
  objectiveErrorId: string;
}) {
  const objectiveId = useId();
  const scopeId = useId();
  const exclusionsId = useId();
  const set = <K extends keyof PreflightControls>(key: K, value: PreflightControls[K]) => onChange({ ...controls, [key]: value });

  return (
    <div className="ws-panel-enter border-b border-white/[0.07] px-3 pb-3 pt-2.5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={objectiveId} className="text-micro font-medium text-muted-foreground">Objective</label>
          <input
            id={objectiveId}
            value={controls.objective}
            onChange={(e) => set("objective", e.target.value)}
            placeholder="What do you need to know? e.g. Who controls this mailbox?"
            aria-invalid={Boolean(result.errors.objective)}
            aria-describedby={result.errors.objective ? objectiveErrorId : undefined}
            className={cn(
              "mt-1 h-9 w-full rounded-md border bg-background/60 px-2.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring",
              result.errors.objective ? "border-[hsl(var(--danger)/0.6)]" : "border-white/[0.09]",
            )}
          />
          {result.errors.objective && (
            <p id={objectiveErrorId} className="mt-1 text-micro text-[hsl(var(--danger))]">{result.errors.objective}</p>
          )}
        </div>
        <div>
          <label htmlFor={scopeId} className="text-micro font-medium text-muted-foreground">Authorized scope</label>
          <div className="relative mt-1">
            <select
              id={scopeId}
              value={controls.scope}
              onChange={(e) => set("scope", e.target.value as ScopePreset)}
              className="h-9 w-full appearance-none rounded-md border border-white/[0.09] bg-background/60 pl-2.5 pr-8 text-[14px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {(Object.keys(SCOPE_LABEL) as ScopePreset[]).map((k) => <option key={k} value={k}>{SCOPE_LABEL[k]}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          </div>
        </div>
        <div>
          <label htmlFor={exclusionsId} className="text-micro font-medium text-muted-foreground">Exclusions and sensitive-data limits</label>
          <input
            id={exclusionsId}
            value={controls.exclusions}
            onChange={(e) => set("exclusions", e.target.value)}
            placeholder="e.g. no relatives, no minors' accounts"
            className="mt-1 h-9 w-full rounded-md border border-white/[0.09] bg-background/60 px-2.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="text-micro font-medium text-muted-foreground">Evidence standard</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
            {EVIDENCE_STANDARD.map((e) => (
              <label key={e.key} className="inline-flex cursor-pointer items-center gap-1.5 text-[13px] text-foreground/90">
                <input
                  type="checkbox"
                  checked={controls.evidence.includes(e.key)}
                  onChange={(ev) => set("evidence", ev.target.checked
                    ? [...controls.evidence, e.key]
                    : controls.evidence.filter((k) => k !== e.key))}
                  className="h-4 w-4 accent-[hsl(var(--brand))]"
                />
                {e.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-micro font-medium text-muted-foreground">Depth</legend>
          <div role="radiogroup" aria-label="Depth" className="mt-1 inline-flex rounded-md bg-white/[0.03] p-0.5">
            {(Object.keys(DEPTH_LABEL) as DepthPreset[]).map((d) => {
              const on = controls.depth === d;
              return (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => set("depth", d)}
                  className={cn(
                    "h-8 rounded px-3 text-data font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on ? "bg-surface-3 text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {DEPTH_LABEL[d]}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div>
          <div className="text-micro font-medium text-muted-foreground">Estimate</div>
          <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
            Unavailable — no per-request estimate is published. The server caps each run's tool and paid calls.
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-micro text-muted-foreground">
        <span>These controls are sent to the agent as written instructions. They guide the run; the server's own caps are what is enforced.</span>
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_CONTROLS, targetKind: controls.targetKind })}
          className="rounded px-1 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

/** The Scope & controls toggle, which names how many controls are customised. */
export function ScopeToggle({ open, onToggle, customized, panelId }: { open: boolean; onToggle: () => void; customized: boolean; panelId: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={panelId}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-data font-medium transition-colors duration-fast [@media(pointer:coarse)]:h-11",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        open || customized ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden min-[420px]:inline">Scope & controls</span>
      {customized && <span aria-label="customised" className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--brand))]" />}
      <ChevronDown className={cn("h-3 w-3 transition-transform duration-fast", open && "rotate-180")} aria-hidden />
    </button>
  );
}
