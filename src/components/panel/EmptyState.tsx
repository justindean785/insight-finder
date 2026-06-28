import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  hint,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("p-6 flex flex-col items-center justify-center text-center gap-2 min-h-[140px]", className)}>
      {Icon && (
        <div className="w-11 h-11 rounded-xl grid place-items-center border border-border-subtle bg-surface-2 text-muted-foreground shadow-e1">
          <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} />
        </div>
      )}
      <div className="text-meta font-semibold text-foreground leading-snug tracking-tight">{title}</div>
      {hint && <div className="text-data text-muted-foreground leading-relaxed max-w-[280px]">{hint}</div>}
    </div>
  );
}