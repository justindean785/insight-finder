import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SwarmMark } from "@/components/ui/swarm-mark";

export default function Auth() {
  const navigate = useNavigate();
  const [siEmail, setSiEmail] = useState("");
  const [siPassword, setSiPassword] = useState("");
  const [suEmail, setSuEmail] = useState("");
  const [suPassword, setSuPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) navigate("/", { replace: true });
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: siEmail, password: siPassword });
    setLoading(false);
    if (error) toast.error(error.message);
  };

  const signUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email: suEmail,
      password: suPassword,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    setLoading(false);
    if (error) toast.error(error.message);
    else toast.success("Check your email to confirm your account.");
  };

  const google = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/`,
      },
    });
    setLoading(false);
    if (error) toast.error(error.message);
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background p-6 overflow-hidden">
      {/* Ambient glow + grid backdrop — sets the analyst-terminal mood without overpowering the card */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 18%, hsl(var(--primary) / 0.18) 0%, transparent 60%), radial-gradient(50% 50% at 80% 95%, hsl(var(--accent) / 0.12) 0%, transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />

      <div className="relative w-full max-w-[400px] space-y-7">
        {/* Identity block */}
        <div className="text-center space-y-3.5">
          <div className="relative inline-flex items-center justify-center w-16 h-16 rounded-2xl glass-strong border border-white/10 mx-auto shadow-[0_8px_40px_-12px_hsl(var(--primary)/0.55)]">
            <SwarmMark className="w-10 h-10" />
          </div>
          <div className="space-y-1.5">
            <h1 className="font-display text-[28px] leading-none font-semibold tracking-tight gradient-text">
              Swarmbot
            </h1>
            <p className="text-muted-foreground text-[13px]">
              OSINT investigator.{" "}
              <span className="font-mono text-foreground/70">seed</span>
              <span className="text-muted-foreground/60"> → </span>
              <span className="font-mono text-foreground/70">intel</span>
              <span className="text-muted-foreground/60"> → </span>
              <span className="font-mono text-foreground/70">report</span>
              <span className="text-muted-foreground/60">.</span>
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/[0.07] glass-card p-5 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.7)]">
          <Tabs defaultValue="signin" className="w-full">
            <TabsList className="grid grid-cols-2 w-full h-9 bg-surface-2/60 p-1">
              <TabsTrigger value="signin" className="text-[13px]">Sign in</TabsTrigger>
              <TabsTrigger value="signup" className="text-[13px]">Sign up</TabsTrigger>
            </TabsList>
            <TabsContent value="signin">
              <form onSubmit={signIn} className="space-y-3.5 mt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="signin-email" className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">Email</Label>
                  <Input id="signin-email" type="email" autoComplete="email" required value={siEmail} onChange={(e) => setSiEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signin-password" className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">Password</Label>
                  <Input id="signin-password" type="password" autoComplete="current-password" required value={siPassword} onChange={(e) => setSiPassword(e.target.value)} />
                </div>
                <Button
                  type="submit"
                  className="w-full h-10 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90 shadow-[0_8px_24px_-8px_hsl(var(--primary)/0.6)] border-0 font-medium"
                  disabled={loading}
                >
                  {loading ? "Signing in…" : "Sign in"}
                </Button>
              </form>
            </TabsContent>
            <TabsContent value="signup">
              <form onSubmit={signUp} className="space-y-3.5 mt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="signup-email" className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">Email</Label>
                  <Input id="signup-email" type="email" autoComplete="email" required value={suEmail} onChange={(e) => setSuEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signup-password" className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">Password</Label>
                  <Input id="signup-password" type="password" autoComplete="new-password" required minLength={6} value={suPassword} onChange={(e) => setSuPassword(e.target.value)} />
                </div>
                <Button
                  type="submit"
                  className="w-full h-10 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90 shadow-[0_8px_24px_-8px_hsl(var(--primary)/0.6)] border-0 font-medium"
                  disabled={loading}
                >
                  {loading ? "Creating…" : "Create account"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/[0.06]" /></div>
            <div className="relative flex justify-center">
              <span className="px-2.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground bg-[hsl(var(--surface-1))]">
                or
              </span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full h-10 bg-transparent border-white/[0.08] hover:bg-white/[0.04] hover:border-white/[0.14] text-foreground/90"
            onClick={google}
            disabled={loading}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 mr-2" aria-hidden>
              <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.65 4.1-5.5 4.1-3.32 0-6-2.74-6-6.1S8.68 6 12 6c1.88 0 3.15.8 3.87 1.5l2.64-2.55C16.78 3.4 14.6 2.4 12 2.4 6.7 2.4 2.4 6.7 2.4 12s4.3 9.6 9.6 9.6c5.55 0 9.22-3.9 9.22-9.4 0-.63-.07-1.1-.16-1.6H12z" />
            </svg>
            Continue with Google
          </Button>
        </div>

        {/* Footnote */}
        <p className="text-center text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60 font-mono">
          authorized analysts only · all activity logged
        </p>
      </div>
    </div>
  );
}