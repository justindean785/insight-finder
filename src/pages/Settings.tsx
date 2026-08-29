import { useState } from "react";
import { useNavigate, Navigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { SUPPORT_MAILTO } from "@/lib/contact";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import { toast } from "sonner";

// ⛔ ACCOUNT DELETION SHIPS DARK. Off unless VITE_ENABLE_ACCOUNT_DELETION is the
// exact string "true" — same convention as VITE_ENABLE_GOOGLE_OAUTH in Auth.tsx, and
// deliberately strict: unset, "1", "TRUE", "yes" and any typo all evaluate to false.
// A control this destructive must fail closed on a malformed value, not guess.
//
// WHY DARK. `delete_my_account()` is irreversible — no soft-delete, no tombstone, no
// export, and no recovery path this repo can perform (only a platform point-in-time
// restore). While JD is the sole user, exposing the control offers ~nothing and risks
// the entire investigation corpus. The reviewed code lands in main; the affordance does
// not appear until the activation runbook in
// supabase/migrations/20260829000000_delete_my_account.sql has been worked through and
// separately authorized.
//
// This gate is the UI boundary only. The RPC's own defences are unchanged and still
// stand on their own: caller-scoped via auth.uid(), zero arguments, and EXECUTE revoked
// from anon/PUBLIC.
const accountDeletionEnabled = import.meta.env.VITE_ENABLE_ACCOUNT_DELETION === "true";

/**
 * Locally cached investigation state, cleared on account deletion.
 *
 * `supabase.auth.signOut()` clears the auth token and nothing else. Everything
 * this app caches about cases — evidence-cluster preferences, per-case caps,
 * review state, tool-call notes, skipped pivots, brain memory decisions — is
 * keyed under these prefixes in localStorage and would otherwise survive the
 * account and be visible to the next person who signs in on this browser.
 *
 * Prefix-matched rather than enumerated, because the case-scoped keys are built
 * per thread and per tool call (`proximity:note:<callId>`,
 * `proximity:pivot-skip:<threadId>`, …) and cannot be listed ahead of time.
 * Scoped to the app's own prefixes so unrelated data on this origin is untouched.
 */
const DELETION_CLEARED_PREFIXES = [
  "proximity:", // case data: clusters, caps, reviews, notes, pivot-skips, density
  "brain_",     // brain memory decisions: deleted / promoted / suppressed / last visited
  "if:",        // app UI preferences
  "if_",        // app diagnostics (last error)
  "sb-",        // Supabase auth tokens; signOut clears these, this is belt-and-braces
];

function clearLocalCaseState(): void {
  for (const store of [
    typeof localStorage !== "undefined" ? localStorage : null,
    typeof sessionStorage !== "undefined" ? sessionStorage : null,
  ]) {
    if (!store) continue;
    try {
      // Snapshot the keys first — removing while iterating by index skips entries.
      const doomed: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && DELETION_CLEARED_PREFIXES.some((p) => key.startsWith(p))) doomed.push(key);
      }
      for (const key of doomed) store.removeItem(key);
    } catch {
      /* storage can be unavailable (private mode, blocked cookies); never block deletion */
    }
  }
}

export default function Settings() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  if (loading) return <FullPageLoader />;

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Password updated");
      setNewPassword("");
      setConfirmPassword("");
    }
  };

  const deleteAccount = async () => {
    // The flag is re-checked HERE, not only at the render site. Conditional
    // rendering is a display decision; this is the call site that actually reaches
    // the RPC, and it is what makes "unreachable through the UI" true rather than
    // merely visually absent.
    if (!accountDeletionEnabled) return;
    // Guarded again here, not only by the disabled button: a disabled attribute is
    // a UI affordance, not an authorization check.
    if (deleteConfirm !== "DELETE" || deleting) return;
    setDeleting(true);
    try {
      const { error } = await supabase.rpc("delete_my_account");
      if (error) throw error;

      // ── Everything below this line runs AFTER the server has already deleted
      // the account. None of it may throw back into the catch: the deletion is
      // done and irreversible, so reporting "Could not delete the account" here
      // would be a lie that invites the analyst to retry a completed action.

      // 1. Drop locally cached case data. signOut() only clears the Supabase auth
      //    token — it does not touch the investigation state this app keeps in
      //    localStorage, which would otherwise outlive the account and surface
      //    under whoever signs in next on this browser.
      clearLocalCaseState();

      // 2. Revoke server-side. Deleting auth.users removes the sessions and
      //    refresh tokens, so no NEW access token can be minted. signOut is still
      //    called to clear the local token and notify listeners; it is allowed to
      //    fail, because the user it would sign out no longer exists.
      try {
        await supabase.auth.signOut();
      } catch {
        /* the account is already gone; nothing to sign out of */
      }

      toast.success("Account deleted");
      navigate("/", { replace: true });
    } catch (e) {
      setDeleting(false);
      toast.error(e instanceof Error ? e.message : "Could not delete the account");
    }
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate("/auth", { replace: true });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-xl px-6 py-12 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link to="/" className="inline-flex items-center justify-center w-9 h-9 rounded-xl glass-strong border border-white/10">
            <SwarmMark className="w-5 h-5" glow={false} />
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        </div>

        {/* Profile */}
        <div className="glass-card rounded-2xl border border-white/[0.07] p-6 space-y-3">
          <h2 className="text-eyebrow uppercase tracking-[0.16em] text-muted-foreground/80 font-mono">Profile</h2>
          <div className="space-y-2">
            <div>
              <span className="text-xs text-muted-foreground">Email</span>
              <p className="text-sm text-foreground">{user.email}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">User ID</span>
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-mono text-muted-foreground">{user.id.slice(0, 12)}…</p>
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard.writeText(user.id).then(
                      () => toast.success("User ID copied"),
                      () => toast.error("Copy failed"),
                    )
                  }
                  aria-label="Copy full user ID"
                  title="Copy full user ID"
                  className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
            </div>
            {user.created_at && (
              <div>
                <span className="text-xs text-muted-foreground">Account created</span>
                <p className="text-sm text-foreground">
                  {new Date(user.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Change password */}
        <div className="glass-card rounded-2xl border border-white/[0.07] p-6">
          <h2 className="text-eyebrow uppercase tracking-[0.16em] text-muted-foreground/80 font-mono mb-4">Change password</h2>
          <form onSubmit={changePassword} className="space-y-3.5">
            <div className="space-y-1.5">
              <Label htmlFor="new-pw" className="text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">New password</Label>
              <PasswordInput id="new-pw" autoComplete="new-password" required minLength={6} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-pw" className="text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">Confirm password</Label>
              <PasswordInput id="confirm-pw" autoComplete="new-password" required minLength={6} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
            <Button type="submit" disabled={saving} variant="cta" className="h-9 border-0 text-xs font-medium">
              {saving ? "Updating…" : "Update password"}
            </Button>
          </form>
        </div>

        {/* Help & feedback */}
        <div className="glass-card rounded-2xl border border-white/[0.07] p-6">
          <h2 className="text-eyebrow uppercase tracking-[0.16em] text-muted-foreground/80 font-mono mb-2">Help &amp; feedback</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Questions, bug reports, or need more beta credits? Reach the team and we&apos;ll get back to you.
          </p>
          <Button asChild variant="outline" className="h-9 text-xs">
            <a href={SUPPORT_MAILTO}>Contact support</a>
          </Button>
        </div>

        {/* Delete account (#476 — CCPA/GDPR). Rendered ONLY when the flag is on:
            when off there is no card, no heading and no copy — not a disabled
            button, which would still advertise an action that must not be taken. */}
        {accountDeletionEnabled && (
        <div className="glass-card rounded-2xl border border-destructive/25 p-6">
          <h2 className="text-eyebrow uppercase tracking-[0.16em] text-destructive/80 font-mono mb-2">Delete account</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Permanently deletes your login and every investigation you have run — cases, evidence,
            artifacts, agent memory, notes and usage history. This cannot be undone.
          </p>
          {/* Disclosed BEFORE confirmation, not after. analyst_feedback_events is an
              append-only hash-chained integrity log that cannot be deleted by anyone,
              including the service role — so saying "everything is deleted" would be
              false. Naming it here is what makes the retention lawful to rely on. */}
          <p className="text-xs text-muted-foreground/80 mb-4 leading-relaxed">
            One exception: the tamper-evident review log (records of accept/reject decisions you made
            on evidence) is append-only and is retained for audit integrity. It holds your decisions,
            not your investigations.
          </p>
          {/* Stated precisely rather than reassuringly. Deleting the auth row removes
              sessions and refresh tokens, so nothing new can be minted — but a Supabase
              access token is a stateless signed JWT and stays signature-valid until its
              own expiry. We sign out to drop the local copy immediately. Claiming
              instant invalidation would be a compliance claim we have not measured. */}
          <p className="text-xs text-muted-foreground/80 mb-4 leading-relaxed">
            You are signed out immediately and this browser's cached case data is cleared. Sessions
            are revoked server-side, so nothing new can be issued; an access token already held by
            another device stays valid until it expires, though every record it could reach is gone.
          </p>
          {!confirmingDelete ? (
            <Button
              variant="outline"
              onClick={() => setConfirmingDelete(true)}
              className="h-9 border-destructive/30 text-destructive hover:bg-destructive/10 text-xs"
            >
              Delete my account
            </Button>
          ) : (
            <div className="space-y-3">
              <Label htmlFor="delete-confirm" className="text-xs text-muted-foreground">
                Type <span className="font-mono text-destructive">DELETE</span> to confirm
              </Label>
              <input
                id="delete-confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                autoComplete="off"
                className="w-full max-w-[240px] rounded-lg border border-white/[0.08] bg-background/60 px-3 py-2 font-mono text-sm"
                placeholder="DELETE"
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={deleteAccount}
                  disabled={deleteConfirm !== "DELETE" || deleting}
                  className="h-9 border-destructive/40 text-destructive hover:bg-destructive/10 text-xs"
                >
                  {deleting ? "Deleting…" : "Permanently delete"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => { setConfirmingDelete(false); setDeleteConfirm(""); }}
                  disabled={deleting}
                  className="h-9 text-xs"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
        )}

        {/* Sign out */}
        <div className="glass-card rounded-2xl border border-white/[0.07] p-6">
          <h2 className="text-eyebrow uppercase tracking-[0.16em] text-muted-foreground/80 font-mono mb-4">Session</h2>
          <Button
            variant="outline"
            onClick={signOut}
            disabled={signingOut}
            className="h-9 border-destructive/30 text-destructive hover:bg-destructive/10 text-xs"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </div>
    </div>
  );
}
