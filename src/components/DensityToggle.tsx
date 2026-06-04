import { Rows3, Rows2, AlignJustify } from "lucide-react";
import { useDensity, type Density } from "@/hooks/useDensity";
import { cn } from "@/lib/utils";

const OPTIONS: { id: Density; label: string; Icon: typeof Rows3 }[] = [
  { id: "compact",  label: "Compact",  Icon: Rows3 },
  { id: "standard", label: "Standard", Icon: Rows2 },
  { id: "roomy",    label: "Roomy",    Icon: AlignJustify },
];

export function DensityToggle({ className }: { className?: string }) {
  const [density, setDensity] = useDensity();
  return (
    <div
      role="radiogroup"
      aria-label="Display density"
      className={cn(
        "inline-flex items-center gap-px rounded-md border border-border-subtle bg-surface-2/60 p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ id, label, Icon }) => {
        const active = density === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setDensity(id)}
            title={`${label} density`}
            className={cn(
              "h-6 w-6 grid place-items-center rounded transition-colors",
              active
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-white/5",
            )}
          >
            <Icon className="w-3 h-3" strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}