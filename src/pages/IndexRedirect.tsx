import { useAuth } from "@/hooks/useAuth";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import Landing from "./Landing";
import HomeHub from "./HomeHub";

/**
 * Root route. Logged-out users see the marketing Landing page;
 * logged-in users see the HomeHub. Thread resume now lives at /chat.
 */
export default function IndexRedirect() {
  const { user, loading } = useAuth();

  if (loading) return <FullPageLoader />;

  if (!user) return <Landing />;
  return <HomeHub />;
}
