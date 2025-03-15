import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import Intro from "@/pages/intro";
import IntroWhat from "@/pages/intro-what";
import IntroHow from "@/pages/intro-how";
import Home from "@/pages/home";
import Missions from "@/pages/missions";
import Wallet from "@/pages/wallet";
import { useEffect, useState } from "react";

function Router() {
  const [loading, setLoading] = useState(true);
  const [hasSeenIntro, setHasSeenIntro] = useState(false);

  useEffect(() => {
    async function checkIntroStatus() {
      try {
        const res = await fetch('/api/check-intro');
        const data = await res.json();
        setHasSeenIntro(data.hasSeenIntro);
      } catch (error) {
        console.error('Failed to check intro status:', error);
      } finally {
        setLoading(false);
      }
    }
    checkIntroStatus();
  }, []);

  if (loading) {
    return null;
  }

  return (
    <Switch>
      <Route path="/" component={hasSeenIntro ? Home : Intro} />
      <Route path="/intro-what" component={IntroWhat} />
      <Route path="/intro-how" component={IntroHow} />
      <Route path="/home" component={Home} />
      <Route path="/missions" component={Missions} />
      <Route path="/wallet" component={Wallet} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router />
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;