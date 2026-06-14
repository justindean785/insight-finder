import { useLocation, Link } from "react-router-dom";
import { useEffect } from "react";
import { SwarmMark } from "@/components/ui/swarm-mark";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-12">
        <div className="glass-card w-full rounded-3xl border border-border-subtle/80 p-8 shadow-[0_30px_120px_-40px_rgba(0,0,0,0.8)] text-center">
          <SwarmMark className="w-10 h-10 mx-auto opacity-40" glow={false} />
          <div className="mt-4 text-eyebrow uppercase tracking-[0.26em] text-warning/80">
            Signal lost
          </div>
          <h1 className="mt-3 text-5xl font-semibold tracking-tight">404</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            This route doesn't exist.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link
              to="/"
              className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-foreground hover:bg-surface-1"
            >
              Go home
            </Link>
            <Link
              to="/auth"
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
