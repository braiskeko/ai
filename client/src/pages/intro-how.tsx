import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";

export default function IntroHow() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);
  const [gridValue, setGridValue] = useState(10);
  const [showLoadingScreen, setShowLoadingScreen] = useState(false);

  const handleNext = async () => {
    setIsLoading(true);
    try {
      await apiRequest('POST', '/api/complete-intro', { gridValue });
      setShowLoadingScreen(true);
      setTimeout(() => {
        setLocation('/home'); 
      }, 3000);
    } catch (error) {
      console.error('Failed to complete intro:', error);
      setIsLoading(false);
    }
  };

  const calculateDailyEarnings = (value: number) => {
    return (value * 0.3038).toFixed(2);
  };

  if (showLoadingScreen) {
    return (
      <div className="min-h-screen bg-[#1a1a1a] flex items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-[#D4A74D]" />
      </div>
    );
  }

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
            <h1 className="text-2xl font-bold text-left tracking-wider text-white mt-2">Getting Started</h1>

            <p className="text-gray-400 text-sm font-['Agrandir-Regular']">
              To get started, simply choose the number of grids you'd like Gridby to trade between and set your desired time horizon.
            </p>

            <div className="w-full bg-[#292929] rounded-lg p-4 mt-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                  <img src="/assets/icons/symbol/btc.svg" alt="BTC" className="w-8 h-8" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="bg-[#392E1E] text-[#D4A74D] px-2 py-1 rounded text-[10px]">
                    X100
                  </span>
                  <span className="text-white text-xs">Mini BTC Grid Bot</span>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-gray-500 text-sm">APY</span>
                <span className="text-white text-sm font-['Arial'] font-bold">11.054,43%</span>
              </div>

              <div className="flex justify-between items-center mt-2">
                <span className="text-gray-500 text-sm">Cost Per Grid</span>
                <span className="text-white text-sm font-['Arial'] font-bold">0.1 TON</span>
              </div>

              <div className="text-center mt-8 mb-6">
                <span className="text-white text-3xl font-bold">{gridValue}</span>
                <span className="text-white text-3xl font-bold"> TON</span>
              </div>

              <Slider 
                value={[gridValue]} 
                onValueChange={(value) => setGridValue(value[0])}
                min={5}
                max={100}
                step={1}
                className="w-full h-3 [&_[role=slider]]:h-5 [&_[role=slider]]:w-5 [&_[role=slider]]:bg-gradient-to-r [&_[role=slider]]:from-[#D4A74D] [&_[role=slider]]:to-[#C39A40]"
              />

              <div className="mt-8">
                <Button 
                  onClick={handleNext}
                  disabled={isLoading}
                  className={`w-full ${isLoading ? 'bg-gray-800' : 'bg-[#D4A74D] hover:bg-[#C39A40]'} text-white rounded-lg h-12 font-sans flex items-center justify-center mb-0 rounded-b-none`} 
                >
                  {isLoading ? (
                    <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  ) : (
                    'Next'
                  )}
                </Button>
                <div className="w-full bg-[#392E1E] text-[#D4A74D] text-xs py-2 rounded-b-lg text-center">
                  You could earn +{calculateDailyEarnings(gridValue)} TON daily
                </div>
              </div>
            </div>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}