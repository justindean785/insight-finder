import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
// Entry/auth routes stay eager — they're tiny and on the first-paint path.
import IndexRedirect from "./pages/IndexRedirect";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";
// Heavy routes are code-split out of the main bundle.
const ChatPage = lazy(() => import("./pages/ChatPage"));
const AdminSecurity = lazy(() => import("./pages/AdminSecurity"));
const BrainGlobalPage = lazy(() => import("./pages/BrainGlobalPage"));
import { hasSupabaseEnv, supabaseConfigError } from "./integrations/supabase/client";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      {!hasSupabaseEnv ? (
        <MissingConfigScreen />
      ) : (
      <BrowserRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <Suspense
          fallback={
            <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>
          }
        >
          <Routes>
            <Route path="/" element={<IndexRedirect />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/chat/:threadId" element={<ChatPage />} />
            <Route path="/brain" element={<BrainGlobalPage />} />
            <Route path="/admin/security" element={<AdminSecurity />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
      )}
    </TooltipProvider>
  </QueryClientProvider>
);

function MissingConfigScreen() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-12">
        <div className="glass-card w-full rounded-3xl border border-border-subtle/80 p-8 shadow-[0_30px_120px_-40px_rgba(0,0,0,0.8)]">
          <div className="text-[10px] uppercase tracking-[0.26em] text-primary/80">Local setup required</div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Frontend env vars are missing</h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            {supabaseConfigError}
          </p>
          <div className="mt-6 rounded-2xl border border-border-subtle/70 bg-black/20 p-4 font-mono text-xs leading-6 text-foreground/90">
            cp .env.example .env{"\n"}
            # then set:{"\n"}
            VITE_SUPABASE_URL=https://&lt;project-id&gt;.supabase.co{"\n"}
            VITE_SUPABASE_PUBLISHABLE_KEY=&lt;anon-publishable-key&gt;{"\n"}
            VITE_SUPABASE_PROJECT_ID=&lt;project-id&gt;
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
