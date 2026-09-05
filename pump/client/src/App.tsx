import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useLiveUpdates } from "@/lib/useLive";
import { I18nProvider } from "@/i18n";
import { AuthProvider } from "@/hooks/useAuth";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import Home from "@/pages/home";
import Coin from "@/pages/coin";
import Create from "@/pages/create";
import Portfolio from "@/pages/portfolio";
import Wallet from "@/pages/wallet";
import Activity from "@/pages/activity";
import Profile from "@/pages/profile";
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
      <Route path="/" component={Home} />
      <Route path="/create" component={Create} />
      <Route path="/portfolio" component={Portfolio} />
      <Route path="/wallet" component={Wallet} />
      <Route path="/activity" component={Activity} />
      <Route path="/admin" component={Admin} />
      <Route path="/u/:username" component={Profile} />
      {/* Coin page: the component validates the CA shape (44 base58 chars ending in "noxia") and renders NotFound otherwise. */}
      <Route path="/:ca" component={Coin} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <TooltipProvider delayDuration={200}>
          <AuthProvider>
            <LiveUpdates />
            <ScrollToTop />
            <Router />
            <Toaster />
          </AuthProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
