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
        <div className="w-10 h-10 rounded-xl grid place-items-center border border-border-subtle bg-secondary/40 text-muted-foreground/70">
          <Icon className="w-4 h-4" />
        </div>
      )}
      <div className="text-data font-medium text-foreground/80 leading-snug">{title}</div>
      {hint && <div className="text-data text-muted-foreground leading-relaxed max-w-[260px]">{hint}</div>}
    </div>
  );
}