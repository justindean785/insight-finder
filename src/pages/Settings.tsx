import { useState } from "react";
import { useNavigate, Navigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SUPPORT_MAILTO } from "@/lib/contact";
import { DELETE_CONFIRM_PHRASE, isDeleteConfirmed } from "@/lib/delete-account-guard";
import { toast } from "sonner";

export default function Settings() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>
    );
  }

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

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate("/auth", { replace: true });
  };

  const deleteConfirmed = isDeleteConfirmed(deleteConfirmText);

  const deleteAccount = async () => {
    if (!deleteConfirmed || deleting) return;
    setDeleting(true);
    const { error } = await supabase.rpc("delete_own_account");
    if (error) {
      setDeleting(false);
      toast.error(error.message || "Couldn't delete your account — contact support.");
      return;
    }
    await supabase.auth.signOut();
    navigate("/auth", { replace: true });
    toast.success("Your account and all associated data have been deleted.");
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
              <p className="text-xs font-mono text-muted-foreground">{user.id.slice(0, 12)}…</p>
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
              <Input id="new-pw" type="password" autoComplete="new-password" required minLength={6} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-pw" className="text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">Confirm password</Label>
              <Input id="confirm-pw" type="password" autoComplete="new-password" required minLength={6} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
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

        {/* Delete account */}
        <div className="glass-card rounded-2xl border border-destructive/20 p-6">
          <h2 className="text-eyebrow uppercase tracking-[0.16em] text-destructive/80 font-mono mb-2">Danger zone</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Permanently delete your account and all associated data — investigations, evidence, notes, and uploads. This cannot be undone.
          </p>
          <AlertDialog onOpenChange={(open) => { if (!open) setDeleteConfirmText(""); }}>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="h-9 border-destructive/30 text-destructive hover:bg-destructive/10 text-xs"
              >
                Delete account
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes your account, every investigation thread, evidence, notes, and uploaded
                  files. There is no way to recover this data afterward. Type <strong>{DELETE_CONFIRM_PHRASE}</strong> to confirm.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Input
                autoFocus
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={DELETE_CONFIRM_PHRASE}
                aria-label={`Type ${DELETE_CONFIRM_PHRASE} to confirm account deletion`}
              />
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!deleteConfirmed || deleting}
                  onClick={(e) => { e.preventDefault(); deleteAccount(); }}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleting ? "Deleting…" : "Delete account permanently"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}
