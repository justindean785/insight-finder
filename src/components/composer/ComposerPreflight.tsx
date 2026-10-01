import { useId } from "react";
import { ChevronDown, Crosshair, Link2, Mail, Phone, Globe, Network, User, Hash, MapPin, FileSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SeedKind } from "@/lib/seed";
import { KIND_LABEL, type PreflightResult } from "@/lib/composer-preflight";

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
