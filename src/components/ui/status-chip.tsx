import { cn } from "@/lib/utils";
import {
  CheckCircle2, Circle, Loader2, XCircle,
  ShieldQuestion, ShieldCheck, ShieldAlert, ShieldX,
} from "lucide-react";

export type Lifecycle = "idle" | "running" | "done" | "failed";
export type Verification = "unverified" | "corroborated" | "disputed" | "confirmed";

const LIFECYCLE_META: Record<Lifecycle, {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  classes: string;
  spin?: boolean;
}> = {
  idle:    { label: "Idle",    icon: Circle,      classes: "text-muted-foreground border-border-subtle bg-surface-2/60" },
  running: { label: "Running", icon: Loader2,     classes: "text-info border-info/30 bg-info/10", spin: true },
  done:    { label: "Done",    icon: CheckCircle2, classes: "text-confidence-high border-confidence-high/30 bg-confidence-high/10" },
  failed:  { label: "Failed",  icon: XCircle,     classes: "text-destructive border-destructive/30 bg-destructive/10" },
};

const VERIFICATION_META: Record<Verification, {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  classes: string;
}> = {
  unverified:   { label: "Unverified",   icon: ShieldQuestion, classes: "text-muted-foreground border-border-subtle bg-surface-2/60" },
  corroborated: { label: "Corroborated", icon: ShieldCheck,    classes: "text-confidence-mid border-[hsl(var(--confidence-mid))]/30 bg-[hsl(var(--confidence-mid))]/10" },
  disputed:     { label: "Disputed",     icon: ShieldAlert,    classes: "text-destructive border-destructive/30 bg-destructive/10" },
  confirmed:    { label: "Confirmed",    icon: ShieldX,        classes: "text-confidence-high border-confidence-high/30 bg-confidence-high/10" },
};

type Props = {
  className?: string;
  size?: "sm" | "md";
} & (
  | { variant: "lifecycle"; value: Lifecycle; label?: string }
  | { variant: "verification"; value: Verification; label?: string }
);

export function StatusChip(props: Props) {
  const { className, size = "sm", label } = props;
  const meta = props.variant === "lifecycle"
    ? LIFECYCLE_META[props.value]
    : VERIFICATION_META[props.value];
  const Icon = meta.icon;
  const spin = props.variant === "lifecycle" && "spin" in meta && meta.spin;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-mono uppercase tracking-[0.08em]",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]",
        meta.classes,
        className,
      )}
    >
      <Icon className={cn("w-3 h-3", spin && "animate-spin")} />
      {label ?? meta.label}
    </span>
  );
}