import { useState, type ComponentProps } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NextSteps } from "./NextSteps";

/** Keep the transcript for reading; actions open deliberately and still preview before dispatch. */
export function SuggestedActions(props: ComponentProps<typeof NextSteps>) {
  const [open, setOpen] = useState(false);
  if (props.items.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="scan-actions-trigger">
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          Suggested actions
          <span>{props.items.length} suggestions</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={10} aria-label="Suggested actions" className="scan-actions-panel w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] max-h-[50vh] overflow-y-auto p-0">
        <div className="sticky top-0 z-10 flex items-center justify-between bg-[#132229] border-b border-white/10 px-4 py-2 text-[12px] text-muted-foreground">
          <span>Review a suggestion before starting a run</span>
          <button type="button" aria-label="Close suggested actions" onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-4 w-4" aria-hidden /></button>
        </div>
        <NextSteps {...props}
          onRunPivot={(pivot) => { setOpen(false); props.onRunPivot(pivot); }}
          onRunAction={(prompt) => { setOpen(false); props.onRunAction(prompt); }}
        />
      </PopoverContent>
    </Popover>
  );
}
