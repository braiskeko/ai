import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence, useSpring, useMotionValue, useTransform } from "framer-motion";
import { Loader2, CheckCircle, LayoutDashboard, Target, Wallet } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";

interface BalanceType {
  TON: number;
  BTC: number;
  ETH: number;
}

function Counter({ from = 0, to = 0 }: { from: number; to: number }) {
  const springValue = useSpring(from, {
    stiffness: 100,
    damping: 30,
    duration: 0.8
  });

  useEffect(() => {
    springValue.set(to);
  }, [to]);

  return <motion.span>{useTransform(springValue, value => value.toFixed(4))}</motion.span>;
}

export default function Home() {
  const [activeSection, setActiveSection] = useState<"available" | "active" | "public">("available");
  const [showGift, setShowGift] = useState(true);
  const [isClaimed, setIsClaimed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showBalanceDetails, setShowBalanceDetails] = useState(false);
  const [selectedCurrency, setSelectedCurrency] = useState<keyof BalanceType>("TON");
  const [previousBalance, setPreviousBalance] = useState<BalanceType>({
    TON: 0,
    BTC: 0,
    ETH: 0
  });
  const [balance, setBalance] = useState<BalanceType>({
    TON: 0,
    BTC: 0,
    ETH: 0
  });
  const [showCoinAnimation, setShowCoinAnimation] = useState(false);
  const [animatingCurrency, setAnimatingCurrency] = useState<keyof BalanceType | null>(null);
  const [, setLocation] = useLocation();
  const detailsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (detailsRef.current && !detailsRef.current.contains(event.target as Node)) {
        setShowBalanceDetails(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleClaim = async () => {
    setIsLoading(true);
    setTimeout(() => {
      setShowCoinAnimation(true);
      setAnimatingCurrency("TON");
      setTimeout(() => {
        setIsClaimed(true);
        setIsLoading(false);
      }, 1500);
      setTimeout(() => {
        setShowGift(false);
      }, 2000);
    }, 1500);
  };

  const formatBalance = (value: number) => {
    return value === 0 ? "0" : value.toFixed(4);
  };

  return (
    <div className="min-h-screen bg-[#1a1a1a] relative">
      <div className="fixed top-4 right-4 z-40">
        <button 
          onClick={() => setShowBalanceDetails(!showBalanceDetails)}
          className={`bg-[#292929] p-3 rounded-lg transition-colors min-w-[140px] ${showBalanceDetails ? 'bg-[#1a1a1a]' : ''}`}
        >
          <div className="flex items-center gap-2 justify-between">
            {selectedCurrency === "TON" && (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" fill="#0088CC"/>
                <path d="M8 12L12 7L16 12L12 17L8 12Z" fill="white"/>
                <path d="M12 7V17" stroke="white" strokeWidth="1.5"/>
              </svg>
            )}
            {selectedCurrency === "BTC" && (
              <img src="/assets/icons/symbol/btc.svg" alt="BTC" className="w-3 h-3" />
            )}
            {selectedCurrency === "ETH" && (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="#627EEA">
                <path d="M12 24c6.627 0 12-5.373 12-12S18.627 0 12 0 0 5.373 0 12s5.373 12 12 12z"/>
                <path d="M12.37 3v6.652l5.623 2.513L12.37 3z" fill="#fff" fillOpacity=".6"/>
                <path d="M12.37 3L6.745 12.165l5.625-2.513V3z" fill="#fff"/>
                <path d="M12.37 16.476v4.52L18 13.212l-5.63 3.264z" fill="#fff" fillOpacity=".6"/>
                <path d="M12.37 20.996v-4.52L6.745 13.212l5.625 7.784z" fill="#fff"/>
              </svg>
            )}
            <div className="flex items-center gap-2">
              <span className="text-white text-xs font-bold">
                {animatingCurrency === selectedCurrency ? (
                  <Counter from={previousBalance[selectedCurrency]} to={balance[selectedCurrency]} />
                ) : (
                  formatBalance(balance[selectedCurrency])
                )}
              </span>
              <svg width="8" height="6" viewBox="0 0 8 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 6L0.535898 0L7.4641 0L4 6Z" fill="white"/>
              </svg>
            </div>
          </div>
        </button>

        <AnimatePresence>
          {showCoinAnimation && (
            <>
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="fixed"
                  initial={{ 
                    x: 0, 
                    y: 400,
                    scale: 1,
                    opacity: 1 
                  }}
                  animate={{ 
                    x: [0, -5 * (i-1)],
                    y: [400, 20],
                    scale: [1, 1, 0],
                    opacity: 1
                  }}
                  transition={{ 
                    duration: 1.5,
                    delay: i * 0.4,
                    ease: [0.2, 0.8, 0.2, 1]
                  }}
                  onAnimationComplete={() => {
                    if (i === 2) {
                      setShowCoinAnimation(false);
                      setPreviousBalance(balance);
                      setBalance(prev => ({
                        ...prev,
                        TON: prev.TON + 0.1
                      }));
                      setTimeout(() => {
                        setAnimatingCurrency(null);
                      }, 1000);
                    }
                  }}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#0088CC"/>
                    <path d="M8 12L12 7L16 12L12 17L8 12Z" fill="white"/>
                    <path d="M12 7V17" stroke="white" strokeWidth="1.5"/>
                  </svg>
                </motion.div>
              ))}
            </>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showBalanceDetails && (
            <motion.div
              ref={detailsRef}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="absolute top-[calc(100%+4px)] right-0 bg-[#292929] rounded-lg p-3 min-w-[140px]"
            >
              <div className="flex flex-col gap-2">
                <button 
                  onClick={() => {
                    setSelectedCurrency("TON");
                    setShowBalanceDetails(false);
                  }}
                  className="flex items-center justify-between p-1 hover:bg-[#1a1a1a] rounded transition-colors"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#0088CC"/>
                    <path d="M8 12L12 7L16 12L12 17L8 12Z" fill="white"/>
                    <path d="M12 7V17" stroke="white" strokeWidth="1.5"/>
                  </svg>
                  <span className="text-white text-xs">
                    {formatBalance(balance.TON)}
                  </span>
                </button>
                <button 
                  onClick={() => {
                    setSelectedCurrency("BTC");
                    setShowBalanceDetails(false);
                  }}
                  className="flex items-center justify-between p-1 hover:bg-[#1a1a1a] rounded transition-colors"
                >
                  <img src="/assets/icons/symbol/btc.svg" alt="BTC" className="w-3 h-3" />
                  <span className="text-white text-xs">{formatBalance(balance.BTC)}</span>
                </button>
                <button 
                  onClick={() => {
                    setSelectedCurrency("ETH");
                    setShowBalanceDetails(false);
                  }}
                  className="flex items-center justify-between p-1 hover:bg-[#1a1a1a] rounded transition-colors"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="#627EEA">
                    <path d="M12 24c6.627 0 12-5.373 12-12S18.627 0 12 0 0 5.373 0 12s5.373 12 12 12z"/>
                    <path d="M12.37 3v6.652l5.623 2.513L12.37 3z" fill="#fff" fillOpacity=".6"/>
                    <path d="M12.37 3L6.745 12.165l5.625-2.513V3z" fill="#fff"/>
                    <path d="M12.37 16.476v4.52L18 13.212l-5.63 3.264z" fill="#fff" fillOpacity=".6"/>
                    <path d="M12.37 20.996v-4.52L6.745 13.212l5.625 7.784z" fill="#fff"/>
                  </svg>
                  <span className="text-white text-xs">{formatBalance(balance.ETH)}</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Card className="w-full max-w-xl p-4 bg-transparent border-none shadow-none mx-auto">
        <div className="flex flex-col items-start gap-8 mt-2">
          {/* Section tabs - Centered */}
          <div className="w-full grid grid-cols-3 gap-0 rounded-lg mb-4 mt-8">
            <button 
              onClick={() => setActiveSection("available")}
              className={`py-3 text-center border-b-2 ${
                activeSection === "available" 
                  ? "text-[#D4A74D] border-[#D4A74D]" 
                  : "text-gray-400 border-transparent"
              }`}
            >
              <div className="flex flex-col items-center">
                <span className="text-xs font-medium">Available</span>
                <span className="text-[8px] opacity-50">1</span>
              </div>
            </button>

            <button 
              onClick={() => setActiveSection("active")}
              className={`py-3 text-center border-b-2 ${
                activeSection === "active"
                  ? "text-[#D4A74D] border-[#D4A74D]"
                  : "text-gray-400 border-transparent"
              }`}
            >
              <div className="flex flex-col items-center">
                <span className="text-xs font-medium">Active</span>
                <span className="text-[8px] opacity-50">31</span>
              </div>
            </button>

            <button 
              onClick={() => setActiveSection("public")}
              className={`py-3 text-center border-b-2 ${
                activeSection === "public"
                  ? "text-[#D4A74D] border-[#D4A74D]"
                  : "text-gray-400 border-transparent"
              }`}
            >
              <div className="flex flex-col items-center">
                <span className="text-xs font-medium">Public</span>
                <span className="text-[8px] opacity-50">31</span>
              </div>
            </button>
          </div>

          {/* USDT Grid Bot Box */}
          <div className="w-full bg-[#292929] rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-medium">USDT Grid Bot</h2>
            </div>
          </div>
        </div>
      </Card>

      {showGift && (
        <div className="fixed inset-0 bg-black bg-opacity-30" />
      )}

      <AnimatePresence>
        {showGift && (
          <motion.div 
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="fixed bottom-0 left-0 w-full h-[30vh] bg-[#292929] rounded-t-xl p-6 z-50"
          >
            <div className="flex flex-col items-center gap-4">
              <h2 className="text-lg font-bold text-white">Daily Gift</h2>

              <p className="text-gray-400 text-xs text-center">
                You have received 
                <span className="inline-flex items-center gap-2 bg-[#D4A74D]/50 px-3 py-1 rounded mx-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#0088CC"/>
                    <path d="M8 12L12 7L16 12L12 17L8 12Z" fill="white"/>
                    <path d="M12 7V17" stroke="white" strokeWidth="1.5"/>
                  </svg>
                  <span className="text-white">0.1 TON</span>
                </span>
                for being here today!
              </p>

              <Button 
                onClick={handleClaim}
                disabled={isLoading || isClaimed}
                className={`w-[98%] mx-auto ${isLoading || isClaimed ? 'bg-gray-800' : 'bg-[#D4A74D] hover:bg-[#C39A40]'} text-white rounded-lg h-12 font-sans flex items-center justify-center`}
              >
                {isLoading ? (
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                ) : isClaimed ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-5 w-5 text-green-500" />
                    <span>Credited</span>
                  </div>
                ) : (
                  'Claim'
                )}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="fixed bottom-0 left-0 w-full bg-[#292929] border-t border-gray-800">
        <div className="max-w-xl mx-auto flex justify-around items-center h-16">
          <button 
            className="flex flex-col items-center gap-1 px-4 py-2 text-[#D4A74D]"
            onClick={() => setLocation('/home')}
          >
            <LayoutDashboard className="h-5 w-5" />
            <span className="text-xs">Home</span>
          </button>

          <button 
            className="flex flex-col items-center gap-1 px-4 py-2 text-gray-400 hover:text-[#D4A74D]"
            onClick={() => setLocation('/missions')}
          >
            <Target className="h-5 w-5" />
            <span className="text-xs">Missions</span>
          </button>

          <button 
            className="flex flex-col items-center gap-1 px-4 py-2 text-gray-400 hover:text-[#D4A74D]"
            onClick={() => setLocation('/wallet')}
          >
            <Wallet className="h-5 w-5" />
            <span className="text-xs">Wallet</span>
          </button>
        </div>
      </div>
    </div>
  );
}