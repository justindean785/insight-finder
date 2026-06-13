import { Link } from "react-router-dom";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-2xl items-start px-6 py-16">
        <div className="glass-card w-full rounded-3xl border border-border-subtle/80 p-8 shadow-[0_30px_120px_-40px_rgba(0,0,0,0.8)]">
          <div className="text-[10px] uppercase tracking-[0.26em] text-muted-foreground/80">Legal</div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Privacy Policy</h1>
          <p className="mt-1 text-xs text-muted-foreground">Last updated: June 2026</p>

          <div className="mt-8 space-y-6 text-sm text-muted-foreground leading-relaxed">
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Information We Collect</h2>
              <p>We collect your email address and authentication credentials when you create an account. We also collect usage data including queries submitted, investigation threads, and saved reports.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">How We Use Your Information</h2>
              <p>Your information is used to provide and improve the Service, authenticate your sessions, maintain your investigation history, and communicate important updates about the Service.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Third-Party Services</h2>
              <p>The Service uses Supabase for authentication and data storage, and may query third-party OSINT data providers to fulfill your research requests. We do not sell your personal information to third parties.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Data Retention</h2>
              <p>Your investigation data is retained as long as your account is active. You may delete individual threads at any time. Account deletion removes all associated data.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Security</h2>
              <p>We implement industry-standard security measures including encrypted connections, row-level security on all database tables, and scoped API keys. However, no method of transmission over the Internet is 100% secure.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Contact</h2>
              <p>For questions about this Privacy Policy or to request data deletion, contact the project maintainer through the application.</p>
            </section>
          </div>

          <div className="mt-8 pt-6 border-t border-border-subtle/50">
            <Link to="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              &larr; Back to home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
