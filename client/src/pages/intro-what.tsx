import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";
import { useState } from "react";

export default function IntroWhat() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);

  const handleNext = async () => {
    setIsLoading(true);
    setTimeout(() => {
      setLocation('/intro-how');
    }, 1200);
  };

  return (
    <div className="min-h-screen bg-[#1a1a1a] relative">
      <motion.div 
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="p-4 pt-8"
      >
        <Card className="w-full max-w-xl p-4 bg-transparent border-none shadow-none mx-auto">
          <div className="flex flex-col items-start gap-4 mt-2">
            <h1 className="text-2xl font-bold text-left tracking-wider text-white mt-2">What is Gridby?</h1>

            <p className="text-gray-400 text-sm font-['Agrandir-Regular']">
              Gridby is your AI-enabled Grid-Trading Companion
            </p>

            <div className="w-full bg-[#292929] rounded-lg p-4 mt-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                  <img src="/assets/icons/symbol/btc.svg" alt="BTC" className="w-8 h-8" />
                  <span className="bg-red-900/50 text-red-500 px-2 py-1 rounded text-[10px]">
                    TUTORIAL
                  </span>
                </div>
                <span className="text-white text-xs">Mini BTC Grid Bot</span>
              </div>

              <img 
                src="https://gridby-bot.appsfoundry.online/assets/images/onboarding/chart-2.svg" 
                alt="Trading Chart" 
                className="w-full h-auto mt-2"
              />

              <p className="text-white text-sm mt-4 font-['Agrandir-Regular']">
                Gridby analyzes market trends and price movements, dynamically adapting the grid setup to capture more opportunities, ensuring efficient trading and consistent returns.
              </p>
            </div>
          </div>
        </Card>
      </motion.div>

      <div className="w-full fixed bottom-[3%] left-0 px-4">
        <Button 
          onClick={handleNext}
          disabled={isLoading}
          className={`w-[98%] mx-auto block ${isLoading ? 'bg-gray-800' : 'bg-[#D4A74D] hover:bg-[#C39A40]'} text-white rounded-lg h-12 font-sans flex items-center justify-center`} 
        >
          {isLoading ? (
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          ) : (
            'Next'
          )}
        </Button>
      </div>
    </div>
  );
}