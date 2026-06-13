import { Link } from "react-router-dom";

export default function Terms() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-2xl items-start px-6 py-16">
        <div className="glass-card w-full rounded-3xl border border-border-subtle/80 p-8 shadow-[0_30px_120px_-40px_rgba(0,0,0,0.8)]">
          <div className="text-[10px] uppercase tracking-[0.26em] text-muted-foreground/80">Legal</div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Terms of Service</h1>
          <p className="mt-1 text-xs text-muted-foreground">Last updated: June 2026</p>

          <div className="mt-8 space-y-6 text-sm text-muted-foreground leading-relaxed">
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Acceptance of Terms</h2>
              <p>By accessing or using Swarmbot ("the Service"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Description of Service</h2>
              <p>Swarmbot is an OSINT (Open Source Intelligence) research tool that aggregates publicly available information. The Service is provided for lawful investigative, journalistic, and research purposes only.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Acceptable Use</h2>
              <p>You agree not to use the Service to harass, stalk, threaten, or intimidate any person; to violate any applicable law or regulation; or to infringe upon the rights of others. You are solely responsible for your use of the intelligence gathered through the Service.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Disclaimer</h2>
              <p>The Service is provided "as is" without warranties of any kind. We do not guarantee the accuracy, completeness, or reliability of any information retrieved through the Service. OSINT data may be outdated, incorrect, or incomplete.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Limitation of Liability</h2>
              <p>To the maximum extent permitted by law, Swarmbot and its operators shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the Service.</p>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-foreground/80 mb-2">Changes to Terms</h2>
              <p>We reserve the right to modify these terms at any time. Continued use of the Service after changes constitutes acceptance of the updated terms.</p>
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
