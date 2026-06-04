import { useState } from "react";
import { Check, Copy, Hash as HashIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * HashChip — forensic-grade display for SHA-256 / chain hashes.
 * Shows first6…last6 in mono, click-to-copy, full value on hover.
 */
export function HashChip({
  value,
  label,
  icon: Icon = HashIcon,
  muted = false,
  className,
}: {
  value: string | null | undefined;
  label?: string;
  icon?: React.ComponentType<{ className?: string }>;
  muted?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) {
    return (
      <span className={cn("inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground/60", className)}>
        <Icon className="w-3 h-3" />
        {label && <span className="opacity-70">{label}</span>}
        <span>—</span>
      </span>
    );
  }
  const short = `${value.slice(0, 6)}…${value.slice(-6)}`;
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        toast.success("Hash copied");
        setTimeout(() => setCopied(false), 1200);
      },
      () => toast.error("Copy failed"),
    );
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={value}
      className={cn(
        "group inline-flex items-center gap-1 font-mono text-[11px] tabular-nums",
        "px-1.5 py-0.5 rounded border border-border-subtle/70 bg-surface-2/60",
        "transition-colors hover:border-evidence/40 hover:bg-evidence/5",
        muted ? "text-muted-foreground" : "text-foreground/85",
        className,
      )}
    >
      <Icon className={cn("w-3 h-3", muted ? "text-muted-foreground/70" : "text-evidence/70")} />
      {label && <span className="text-muted-foreground/80">{label}</span>}
      <span>{short}</span>
      {copied ? (
        <Check className="w-3 h-3 text-confidence-high opacity-80" />
      ) : (
        <Copy className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />
      )}
    </button>
  );
}