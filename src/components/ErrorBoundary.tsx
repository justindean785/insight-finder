import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureError, getBreadcrumbs, type CapturedError } from "@/lib/telemetry";

type Props = { children: ReactNode };
type State = { record: CapturedError | null };

/**
 * Root error boundary. Catches render-time errors anywhere in the tree and shows
 * a recovery screen instead of a blank page. Async errors don't reach here —
 * those are caught by the global handlers in telemetry.installGlobalHandlers().
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { record: null };

  componentDidCatch(error: Error, info: ErrorInfo) {
    const record = captureError(error, "react.errorBoundary", {
      componentStack: info.componentStack,
    });
    this.setState({ record });
  }

  private reload = () => window.location.reload();

  private copyDiagnostics = () => {
    const payload = this.state.record ?? {
      message: "unknown",
      breadcrumbs: getBreadcrumbs(),
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).catch(() => {
      /* clipboard blocked — nothing more we can safely do */
    });
  };

  render() {
    const { record } = this.state;
    if (!record) return this.props.children;

    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-12">
          <div className="glass-card w-full rounded-3xl border border-border-subtle/80 p-8 shadow-[0_30px_120px_-40px_rgba(0,0,0,0.8)]">
            <div className="text-[10px] uppercase tracking-[0.26em] text-destructive/80">
              Something broke
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">
              The app hit an unexpected error
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Your data is safe — this is a display error. Reloading usually fixes it.
              If it keeps happening, copy the diagnostics and send them over.
            </p>

            <div className="mt-5 rounded-2xl border border-border-subtle/70 bg-black/20 p-4 font-mono text-xs leading-6 text-foreground/90">
              {record.message}
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                onClick={this.reload}
                className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-foreground hover:bg-surface-1"
              >
                Reload app
              </button>
              <button
                onClick={this.copyDiagnostics}
                className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Copy diagnostics
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
