import { Card } from "@/components/ui/card";
import { LayoutDashboard, Target, Wallet } from "lucide-react";
import { useLocation } from "wouter";

export default function Missions() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-[#1a1a1a] p-4 pt-8 pb-24">
      <Card className="w-full max-w-xl mx-auto bg-transparent border-none shadow-none">
        <h1 className="text-2xl font-bold text-white mb-6">Daily Missions</h1>
      </Card>

      <div className="fixed bottom-0 left-0 w-full bg-[#292929] border-t border-gray-800">
        <div className="max-w-xl mx-auto flex justify-around items-center h-16">
          <button 
            className="flex flex-col items-center gap-1 px-4 py-2 text-gray-400 hover:text-[#D4A74D]"
            onClick={() => setLocation('/dashboard')}
          >
            <LayoutDashboard className="h-5 w-5" />
            <span className="text-xs">Home</span>
          </button>

          <button 
            className="flex flex-col items-center gap-1 px-4 py-2 text-[#D4A74D]"
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