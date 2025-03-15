import { motion } from "framer-motion";
import { useLocation } from "wouter";
import RainbowText from "@/components/RainbowText";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useState } from "react";

export default function Intro() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);

  const handleNext = async () => {
    setIsLoading(true);
    setTimeout(() => {
      setLocation('/intro-what');
    }, 1200);
  };

  return (
    <div className="min-h-screen bg-[#1a1a1a] flex items-center p-4">
      <Card className="w-full max-w-md p-6 bg-transparent border-none shadow-none ml-4 sm:ml-8">
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 1, ease: "easeOut" }}
          className="flex flex-col items-start gap-6" 
        >
          <RainbowText text="Gridby" className="text-5xl font-bold text-left tracking-wider" />

          <div className="flex flex-col gap-4">
            <motion.p
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 1, ease: "easeOut" }}
              className="text-left text-gray-400 font-bold text-base"
            >
              Your AI-Drive companion that never misses a beat in the grid.
            </motion.p>

            <motion.p
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 1, ease: "easeOut" }}
              className="text-left text-gray-400 font-bold text-sm"
            >
              Smarter trades, Smarter profits.
            </motion.p>
          </div>
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
      </Card>
    </div>
  );
}