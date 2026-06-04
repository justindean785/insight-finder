import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { StickyNote, Save, Loader2, Check } from "lucide-react";
import { toast } from "sonner";

type Note = { id: string; body: string; updated_at: string };

export function NotesTab({ threadId }: { threadId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from("investigator_notes")
      .select("id,body,updated_at")
      .eq("thread_id", threadId)
      .order("updated_at", { ascending: false });
    setNotes((data ?? []) as Note[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    const ch = supabase
      .channel(`notes-${threadId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "investigator_notes", filter: `thread_id=eq.${threadId}` },
        () => { void load(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Handle "Save note" requests dispatched from the chat composer.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ threadId: string; body: string }>;
      if (!ce.detail || ce.detail.threadId !== threadId) return;
      setDraft((d) => (d ? d + "\n\n" + ce.detail.body : ce.detail.body));
      taRef.current?.focus();
    };
    window.addEventListener("proximity:save-note", handler as EventListener);
    return () => window.removeEventListener("proximity:save-note", handler as EventListener);
  }, [threadId]);

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) { toast.error("Not signed in"); setSaving(false); return; }
    if (editingId) {
      const { error } = await supabase
        .from("investigator_notes")
        .update({ body })
        .eq("id", editingId);
      if (error) toast.error(error.message); else toast.success("Note updated");
    } else {
      const { error } = await supabase
        .from("investigator_notes")
        .insert({ thread_id: threadId, user_id: uid, body });
      if (error) toast.error(error.message); else toast.success("Note saved");
    }
    setDraft("");
    setEditingId(null);
    setSaving(false);
  };

  const edit = (n: Note) => { setEditingId(n.id); setDraft(n.body); taRef.current?.focus(); };
  const del = async (id: string) => {
    const { error } = await supabase.from("investigator_notes").delete().eq("id", id);
    if (error) toast.error(error.message); else toast.success("Deleted");
  };

  return (
    <div className="p-3 space-y-3 text-xs">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <StickyNote className="w-3.5 h-3.5 text-primary" />
        <span>Investigator notes — markdown, scoped to this thread.</span>
      </div>
      <div className="space-y-1.5">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={editingId ? "Editing note…" : "Write a note (markdown). Cmd/Ctrl+Enter to save."}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void save(); }
          }}
          className="w-full min-h-[120px] rounded-md border border-border bg-card/40 p-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <div className="flex items-center justify-end gap-1">
          {editingId && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => { setEditingId(null); setDraft(""); }}>
              Cancel
            </Button>
          )}
          <Button size="sm" disabled={saving || !draft.trim()} className="h-7 px-2.5 gap-1 text-[11px]" onClick={() => void save()}>
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {editingId ? "Update" : "Save note"}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Saved</span>
          <span className="font-mono">{notes.length}</span>
        </div>
        {loading ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : notes.length === 0 ? (
          <div className="text-muted-foreground">No notes yet.</div>
        ) : (
          <ul className="space-y-1.5">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md border border-border bg-card/40 p-2 space-y-1">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span className="font-mono">{new Date(n.updated_at).toLocaleString()}</span>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={() => edit(n)}>Edit</Button>
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive" onClick={() => void del(n.id)}>Delete</Button>
                  </div>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">{n.body}</pre>
                {editingId === n.id && (
                  <div className="flex items-center gap-1 text-[10px] text-primary">
                    <Check className="w-3 h-3" /> Editing above
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}