import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider, type ConnectionProviderProps } from "@solana/wallet-adapter-react";
import { queryClient } from "@/lib/queryClient";
import { useLiveUpdates } from "@/lib/useLive";
import { I18nProvider } from "@/i18n";
import { AuthProvider } from "@/hooks/useAuth";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useEmbeddedWallet } from "@/hooks/useEmbeddedWallet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import Home from "@/pages/home";
import Coin from "@/pages/coin";
import Token from "@/pages/token";
import Create from "@/pages/create";
import Portfolio from "@/pages/portfolio";
import Wallet from "@/pages/wallet";
import Feed from "@/pages/feed";
import Search from "@/pages/search";
import People from "@/pages/people";
import TradeSheet from "@/pages/tradeSheet";
import Perp from "@/pages/perp";
import Profile from "@/pages/profile";
import MyProfile from "@/pages/my-profile";
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

/**
 * Gives every signed-in account its own wallet (created in the browser, linked with
 * a signed challenge) so nobody has to install an extension to trade or launch.
 */
function WalletProvisioner() {
  useEmbeddedWallet();
  return null;
}

// The connection endpoint is required by the wallet-adapter plumbing but is
// never actually used for RPC calls — the browser never talks to an RPC
// directly; the server builds/relays/confirms every transaction (see
// lib/solana.ts). Wallet Standard auto-detects installed wallets (Phantom,
// Solflare, Backpack, ...), so no adapter list is needed here.
const SOLANA_RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";

// @solana/wallet-adapter-react ships its own (newer) nested @types/react, which
// TS resolves to a different `ReactNode` than this project's @types/react and
// then rejects as a JSX component. Re-typing it against our own React types
// once here avoids a package-manager-level dedupe just for a type mismatch.
const SolanaConnectionProvider = ConnectionProvider as unknown as (props: ConnectionProviderProps) => JSX.Element;

function Router() {
  const [location] = useLocation();
  return (
    <ErrorBoundary resetKey={location}>
      <Routes />
    </ErrorBoundary>
  );
}

function Routes() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/create" component={Create} />
      <Route path="/portfolio" component={Portfolio} />
      <Route path="/wallet" component={Wallet} />
      <Route path="/search" component={Search} />
      <Route path="/people" component={People} />
      <Route path="/perp/:symbol" component={Perp} />
      <Route path="/feed" component={Feed} />
      {/* Activity is now the Feed screen; kept as an alias so old links/bookmarks still work. */}
      <Route path="/activity" component={Feed} />
      <Route path="/admin" component={Admin} />
      <Route path="/profile" component={MyProfile} />
      <Route path="/u/:username">{() => <Profile />}</Route>
      {/* Full-screen buy/sell keypad (mobile). Must stay above "/:ca". */}
      <Route path="/buy/:mint" component={TradeSheet} />
      <Route path="/sell/:mint" component={TradeSheet} />
      {/* Any Solana token that was NOT launched here (traded through Jupiter). Must stay above "/:ca". */}
      <Route path="/t/:mint" component={Token} />
      {/* Coin page: the component validates the CA shape (44 base58 chars ending in "next") and renders NotFound otherwise. */}
      <Route path="/:ca" component={Coin} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <SolanaConnectionProvider endpoint={SOLANA_RPC_ENDPOINT}>
      <WalletProvider wallets={[]} autoConnect>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <TooltipProvider delayDuration={200}>
              <AuthProvider>
                <LiveUpdates />
                <WalletProvisioner />
                <ScrollToTop />
                <Router />
                <Toaster />
              </AuthProvider>
            </TooltipProvider>
          </I18nProvider>
        </QueryClientProvider>
      </WalletProvider>
    </SolanaConnectionProvider>
  );
}
