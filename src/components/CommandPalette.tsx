import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  Database, BarChart3, Lock, FileOutput, Network, Sparkles,
  Clock, Map as MapIcon, FileText, ShieldCheck, AlertTriangle,
  Search, ArrowRight, MessageSquare,
} from "lucide-react";

type Thread = { id: string; title: string; seed_value: string | null; updated_at: string };

type NavTarget = {
  id: string;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  section: "evidence" | "analysis" | "provenance" | "output";
  tab: string;
};

const NAV_TARGETS: NavTarget[] = [
  { id: "ev-artifacts", label: "Artifacts",  hint: "Evidence",   icon: Database,     section: "evidence",   tab: "artifacts" },
  { id: "ev-clusters",  label: "Clusters",   hint: "Evidence",   icon: Network,      section: "evidence",   tab: "clusters"  },
  { id: "ev-matrix",    label: "Matrix",     hint: "Evidence",   icon: BarChart3,    section: "evidence",   tab: "matrix"    },
  { id: "an-overview",  label: "Overview",   hint: "Analysis",   icon: Sparkles,     section: "analysis",   tab: "overview"  },
  { id: "an-pivots",    label: "Pivots",     hint: "Analysis",   icon: ArrowRight,   section: "analysis",   tab: "pivots"    },
  { id: "an-timeline",  label: "Timeline",   hint: "Analysis",   icon: Clock,        section: "analysis",   tab: "timeline"  },
  { id: "an-map",       label: "Map",        hint: "Analysis",   icon: MapIcon,      section: "analysis",   tab: "map"       },
  { id: "pv-custody",   label: "Custody",    hint: "Provenance", icon: Lock,         section: "provenance", tab: "custody"   },
  { id: "pv-audit",     label: "Audit",      hint: "Provenance", icon: ShieldCheck,  section: "provenance", tab: "audit"     },
  { id: "pv-issues",    label: "Issues",     hint: "Provenance", icon: AlertTriangle,section: "provenance", tab: "issues"    },
  { id: "ou-notes",     label: "Notes",      hint: "Output",     icon: FileOutput,   section: "output",     tab: "notes"     },
  { id: "ou-report",    label: "Report",     hint: "Output",     icon: FileText,     section: "output",     tab: "report"    },
];

function navigateToTab(t: NavTarget) {
  window.dispatchEvent(
    new CustomEvent("swarmbot:navigate", { detail: { section: t.section, tab: t.tab } }),
  );
}

function focusChat() {
  // ChatWindow's PromptInputTextarea is the only multiline textarea on the page.
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder], textarea[data-slot="prompt-input-textarea"]',
    );
    el?.focus();
  });
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loadError, setLoadError] = useState(false);
  const navigate = useNavigate();

  // Cmd/Ctrl+K toggle, ESC handled by Dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Lazy-load recent threads when the palette opens. Surface load failures so a
  // query error is distinguishable from a genuinely empty case list.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadError(false);
    (async () => {
      const { data, error } = await supabase
        .from("threads")
        .select("id,title,seed_value,updated_at")
        .order("updated_at", { ascending: false })
        .limit(12);
      if (!alive) return;
      if (error) {
        setLoadError(true);
        return;
      }
      if (data) setThreads(data as Thread[]);
    })();
    return () => { alive = false; };
  }, [open]);

  const grouped = useMemo(() => {
    const out: Record<string, NavTarget[]> = {};
    for (const t of NAV_TARGETS) (out[t.hint] ??= []).push(t);
    return out;
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search cases, jump to a tab, run an action…" />
      <CommandList className="max-h-[440px]">
        <CommandEmpty>No matches.</CommandEmpty>

        {loadError && (
          <div className="px-3 py-2 text-[11px] text-destructive">
            Couldn't load recent cases. Close and reopen to retry.
          </div>
        )}

        <CommandGroup heading="Quick actions">
          <PaletteItem
            icon={MessageSquare}
            label="Focus chat input"
            shortcut="↵"
            onSelect={() => { setOpen(false); focusChat(); }}
          />
          <PaletteItem
            icon={Search}
            label="Re-run Swarmbot on current seed"
            hint="Sends a fresh run prompt"
            onSelect={() => {
              setOpen(false);
              focusChat();
            }}
          />
        </CommandGroup>

        {Object.entries(grouped).map(([section, items]) => (
          <CommandGroup key={section} heading={`Jump to ${section}`}>
            {items.map((t) => (
              <PaletteItem
                key={t.id}
                icon={t.icon}
                label={t.label}
                hint={section}
                onSelect={() => { setOpen(false); navigateToTab(t); }}
              />
            ))}
          </CommandGroup>
        ))}

        {threads.length > 0 && (
          <CommandGroup heading="Open case">
            {threads.map((th) => (
              <PaletteItem
                key={th.id}
                icon={Database}
                label={th.title || th.seed_value || "Untitled case"}
                hint={th.seed_value ?? ""}
                onSelect={() => { setOpen(false); navigate(`/chat/${th.id}`); }}
              />
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function PaletteItem({
  icon: Icon, label, hint, shortcut, onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem onSelect={onSelect} className="gap-3">
      <Icon className="w-4 h-4 text-muted-foreground" />
      <span className="flex-1 truncate text-foreground">{label}</span>
      {hint && <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{hint}</span>}
      {shortcut && (
        <kbd className="ml-1 px-1.5 py-0.5 rounded border border-border-subtle bg-surface-2 text-[10px] font-mono text-muted-foreground">
          {shortcut}
        </kbd>
      )}
    </CommandItem>
  );
}