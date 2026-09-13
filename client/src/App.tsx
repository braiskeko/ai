import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useLiveUpdates } from "@/lib/useLive";
import { AuthProvider } from "@/hooks/useAuth";
import { Toaster } from "@/components/ui/toaster";
import Landing from "@/pages/landing";
import Markets from "@/pages/markets";
import Market from "@/pages/market";
import Portfolio from "@/pages/portfolio";
import Wallet from "@/pages/wallet";
import Activity from "@/pages/activity";
import Leaderboard from "@/pages/leaderboard";
import Create from "@/pages/create";
import Admin from "@/pages/admin";
import NotFound from "@/pages/not-found";

/** Scrolls to the top whenever the pathname changes (browser back/forward keeps its own position). */
function ScrollToTop() {
  const [pathname] = useLocation();
  useEffect(() => {
    if (window.location.hash) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname]);
  return null;
}

/** Subscribes to the realtime feed once for the whole app. */
function LiveUpdates() {
  useLiveUpdates();
  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/markets" component={Markets} />
      <Route path="/market/:slug" component={Market} />
      <Route path="/portfolio" component={Portfolio} />
      <Route path="/wallet" component={Wallet} />
      <Route path="/activity" component={Activity} />
      <Route path="/leaderboard" component={Leaderboard} />
      <Route path="/create" component={Create} />
      <Route path="/admin" component={Admin} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <LiveUpdates />
        <ScrollToTop />
        <Router />
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
