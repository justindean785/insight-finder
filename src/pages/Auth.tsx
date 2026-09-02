import { memo, useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { probeOAuthProvider } from "@/lib/oauth-preflight";
import { ArrowRight, Fingerprint, Network, ScanSearch, ShieldCheck } from "lucide-react";

// Google OAuth is hidden for beta: the managed provider is toggled on in Supabase
// but has no client secret, so /auth/v1/authorize?provider=google returns 400.
// Email/password is the shipping path. Set VITE_ENABLE_GOOGLE_OAUTH="true" to
// re-show the button once the Google client id/secret are configured — the click
// handler still pre-flights, so it can never strand a user on the raw error page.
const googleEnabled = import.meta.env.VITE_ENABLE_GOOGLE_OAUTH === "true";

const OperationsBrief = memo(function OperationsBrief() {
  return (
  <section className="relative hidden overflow-hidden border-r border-white/[0.07] p-10 lg:flex lg:flex-col xl:p-14">
  <div aria-hidden className="signal-sweep pointer-events-none absolute inset-0 opacity-60" />
  <div aria-hidden className="pointer-events-none absolute -left-24 top-12 h-72 w-72 rounded-full bg-[hsl(var(--intel-blue)/0.08)] blur-[90px]" />
  
  <header className="relative flex items-center justify-between">
  <div className="flex items-center gap-3">
  <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/[0.045] shadow-[inset_0_1px_0_hsl(var(--film)/0.07)]">
  <SwarmMark className="h-7 w-7" />
  </div>
  <div>
  <div className="font-display text-lg font-semibold tracking-tight">Insight Finder</div>
  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Analyst operations platform</div>
  </div>
  </div>
  <span className="rounded-full border border-[hsl(var(--success)/0.28)] bg-[hsl(var(--success-muted))] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-[hsl(var(--success))]">
  Secure access
  </span>
  </header>
  
  <div className="relative my-auto max-w-[590px] py-12">
  <div className="mb-5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-[hsl(var(--intel-blue))]">
  <span className="h-px w-8 bg-[hsl(var(--intel-blue)/0.65)]" />
  Intelligence workspace
  </div>
  <h1 className="max-w-[560px] font-display text-[clamp(2.6rem,4.8vw,4.7rem)] font-semibold leading-[0.98] tracking-[-0.045em]">
  Turn fragments into defensible intelligence.
  </h1>
  <p className="mt-6 max-w-[540px] text-[15px] leading-7 text-muted-foreground">
  Investigate selectors, preserve provenance, resolve contradictions, and produce reports built for review—not just discovery.
  </p>
  
  <div className="mt-10 grid gap-2.5">
  <div className="instrument-panel group flex items-center gap-4 rounded-xl px-4 py-3.5">
  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[hsl(var(--intel-blue)/0.24)] bg-[hsl(var(--intel-blue)/0.08)] text-[hsl(var(--intel-blue))]">
  <ScanSearch className="h-4 w-4" strokeWidth={1.7} aria-hidden />
  </div>
  <div className="min-w-0 flex-1">
  <div className="text-sm font-medium">Selector-led investigation</div>
  <div className="mt-0.5 text-xs text-muted-foreground">Pivot across people, accounts, domains, infrastructure, and documents.</div>
  </div>
  <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" aria-hidden />
  </div>
  <div className="instrument-panel group flex items-center gap-4 rounded-xl px-4 py-3.5">
  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[hsl(var(--success)/0.24)] bg-[hsl(var(--success-muted))] text-[hsl(var(--success))]">
  <Network className="h-4 w-4" strokeWidth={1.7} aria-hidden />
  </div>
  <div className="min-w-0 flex-1">
  <div className="text-sm font-medium">Corroboration before conclusion</div>
  <div className="mt-0.5 text-xs text-muted-foreground">Separate leads from verified findings with source-aware confidence.</div>
  </div>
  <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" aria-hidden />
  </div>
  <div className="instrument-panel group flex items-center gap-4 rounded-xl px-4 py-3.5">
  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[hsl(var(--warning)/0.24)] bg-[hsl(var(--warning-muted))] text-[hsl(var(--warning))]">
  <ShieldCheck className="h-4 w-4" strokeWidth={1.7} aria-hidden />
  </div>
  <div className="min-w-0 flex-1">
  <div className="text-sm font-medium">Evidence with an audit trail</div>
  <div className="mt-0.5 text-xs text-muted-foreground">Review state, custody history, and source provenance remain attached.</div>
  </div>
  <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" aria-hidden />
  </div>
  </div>
  </div>
  
  <footer className="relative grid grid-cols-3 divide-x divide-white/[0.07] border-t border-white/[0.07] pt-5">
  <div className="pr-4">
  <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Method</div>
  <div className="mt-1 text-xs text-foreground/85">Evidence-first</div>
  </div>
  <div className="px-4">
  <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Review</div>
  <div className="mt-1 text-xs text-foreground/85">Human-controlled</div>
  </div>
  <div className="pl-4">
  <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Output</div>
  <div className="mt-1 text-xs text-foreground/85">Audit-ready</div>
  </div>
  </footer>
  </section>
  );
});

export default function Auth() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const defaultTab = searchParams.get("tab") === "signup" ? "signup" : "signin";
  const [siEmail, setSiEmail] = useState("");
  const [siPassword, setSiPassword] = useState("");
  const [suEmail, setSuEmail] = useState("");
  const [suPassword, setSuPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [resetEmail, setResetEmail] = useState("");

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
    const { data, error } = await supabase.auth.signUp({
      email: suEmail,
      password: suPassword,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    // Base the message on the actual result, not the old confirm-email assumption.
    // With auto-confirm on, signUp returns a live session and onAuthStateChange
    // routes straight into the app — so "check your email" is wrong. Only prompt
    // for confirmation when there's genuinely no session yet.
    if (data.session) {
      toast.success("Welcome — you're in.");
    } else {
      toast.success("Check your email to confirm your account.");
    }
  };

  const resetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
      redirectTo: `${window.location.origin}/auth`,
    });
    setLoading(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Check your email for a reset link.");
      setForgotMode(false);
      setResetEmail("");
    }
  };

  const google = async () => {
    setLoading(true);
    // Pre-flight the provider so a beta user never lands on Supabase's raw JSON
    // error page when Google isn't fully configured (provider enabled but no
    // client secret → "missing OAuth secret"). Self-healing: once the secret is
    // set in Supabase, the probe passes and the normal OAuth redirect runs.
    const ready = await probeOAuthProvider("google");
    if (!ready) {
      toast.error("Google sign-in isn't available yet — please continue with email.");
      setLoading(false);
      return;
    }
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
    <main className="ops-shell relative min-h-[100dvh] overflow-hidden bg-background p-3 text-foreground sm:p-6">
      <div aria-hidden className="ops-grid pointer-events-none absolute inset-0 opacity-70" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--intel-blue)/0.7)] to-transparent" />

      <div className="relative mx-auto grid min-h-[calc(100dvh-1.5rem)] w-full max-w-[1180px] overflow-hidden rounded-[26px] border border-white/[0.08] bg-[hsl(var(--surface-0)/0.86)] shadow-[0_40px_140px_-52px_rgba(0,0,0,0.95)] backdrop-blur-xl sm:min-h-[calc(100dvh-3rem)] lg:grid-cols-[1.08fr_0.92fr]">
        <OperationsBrief />

        <section className="relative flex min-h-[680px] items-center justify-center p-5 sm:p-10 lg:min-h-0 xl:p-14">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_50%_at_50%_0%,hsl(var(--intel-blue)/0.08),transparent_72%)]" />
          <div className="relative w-full max-w-[410px]">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/[0.045]">
                <SwarmMark className="h-7 w-7" />
              </div>
              <div>
                <div className="font-display text-lg font-semibold">Insight Finder</div>
                <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Analyst operations</div>
              </div>
            </div>

            <div className="mb-7">
              <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[hsl(var(--intel-blue))]">
                <Fingerprint className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden />
                Identity verification
              </div>
              <h2 className="font-display text-3xl font-semibold tracking-[-0.035em]">Enter the workspace</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Use your authorized analyst account to continue.</p>
            </div>

            <div className="instrument-panel relative overflow-hidden rounded-2xl p-5 sm:p-6">
              <div className="live-seam" aria-hidden />
              <Tabs defaultValue={defaultTab} className="w-full">
                <TabsList className="grid h-10 w-full grid-cols-2 rounded-lg border border-white/[0.06] bg-black/25 p-1">
                  <TabsTrigger value="signin" className="text-meta">Sign in</TabsTrigger>
                  <TabsTrigger value="signup" className="text-meta">Create account</TabsTrigger>
                </TabsList>

                <TabsContent value="signin">
                  {forgotMode ? (
                    <form onSubmit={resetPassword} className="mt-5 space-y-4">
                      <p className="text-data leading-5 text-muted-foreground">Enter your email and we'll send a secure password reset link.</p>
                      <div className="space-y-1.5">
                        <Label htmlFor="reset-email" className="text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">Email</Label>
                        <Input id="reset-email" type="email" autoComplete="email" required value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} className="h-11 bg-black/25" />
                      </div>
                      <Button type="submit" variant="cta" className="h-11 w-full border-0 font-medium shadow-cta" disabled={loading}>
                        {loading ? "Sending…" : "Send reset link"}
                      </Button>
                      <button type="button" onClick={() => setForgotMode(false)} className="w-full rounded-md py-1 text-data text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                        Back to sign in
                      </button>
                    </form>
                  ) : (
                    <form onSubmit={signIn} className="mt-5 space-y-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="signin-email" className="text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">Email</Label>
                        <Input id="signin-email" type="email" autoComplete="email" required value={siEmail} onChange={(e) => setSiEmail(e.target.value)} className="h-11 bg-black/25" />
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="signin-password" className="text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">Password</Label>
                          <button type="button" onClick={() => setForgotMode(true)} className="rounded-sm text-eyebrow uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                            Forgot password?
                          </button>
                        </div>
                        <PasswordInput id="signin-password" autoComplete="current-password" required value={siPassword} onChange={(e) => setSiPassword(e.target.value)} className="h-11 bg-black/25" />
                      </div>
                      <Button type="submit" variant="cta" className="h-11 w-full border-0 font-medium shadow-cta" disabled={loading}>
                        {loading ? "Verifying…" : "Sign in to workspace"}
                        {!loading && <ArrowRight className="ml-2 h-4 w-4" aria-hidden />}
                      </Button>
                    </form>
                  )}
                </TabsContent>

                <TabsContent value="signup">
                  <form onSubmit={signUp} className="mt-5 space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="signup-email" className="text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">Email</Label>
                      <Input id="signup-email" type="email" autoComplete="email" required value={suEmail} onChange={(e) => setSuEmail(e.target.value)} className="h-11 bg-black/25" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="signup-password" className="text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">Password</Label>
                      <PasswordInput id="signup-password" autoComplete="new-password" required minLength={6} value={suPassword} onChange={(e) => setSuPassword(e.target.value)} className="h-11 bg-black/25" />
                      <p className="text-data text-muted-foreground/70">Minimum 6 characters</p>
                    </div>
                    <Button type="submit" variant="cta" className="h-11 w-full border-0 font-medium shadow-cta" disabled={loading}>
                      {loading ? "Provisioning…" : "Create analyst account"}
                      {!loading && <ArrowRight className="ml-2 h-4 w-4" aria-hidden />}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>

              {googleEnabled && (
                <>
                  <div className="relative my-5">
                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/[0.06]" /></div>
                    <div className="relative flex justify-center"><span className="bg-[hsl(var(--surface-1))] px-2.5 text-eyebrow uppercase tracking-[0.18em] text-muted-foreground">or</span></div>
                  </div>
                  <Button type="button" variant="outline" className="h-11 w-full border-white/10 bg-white/[0.035] text-foreground/90 hover:bg-white/[0.06]" onClick={google} disabled={loading}>
                    <svg viewBox="0 0 24 24" className="mr-2 h-4 w-4" aria-hidden>
                      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.65 4.1-5.5 4.1-3.32 0-6-2.74-6-6.1S8.68 6 12 6c1.88 0 3.15.8 3.87 1.5l2.64-2.55C16.78 3.4 14.6 2.4 12 2.4 6.7 2.4 2.4 6.7 2.4 12s4.3 9.6 9.6 9.6c5.55 0 9.22-3.9 9.22-9.4 0-.63-.07-1.1-.16-1.6H12z" />
                    </svg>
                    Continue with Google
                  </Button>
                </>
              )}
            </div>

            <div className="mt-5 flex flex-col items-center justify-between gap-3 text-[10px] text-muted-foreground sm:flex-row">
              <div className="font-mono uppercase tracking-[0.16em]">Authorized access · activity logged</div>
              <div className="flex items-center gap-2">
                <Link to="/terms" className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">Terms</Link>
                <span aria-hidden>·</span>
                <Link to="/privacy" className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">Privacy</Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
