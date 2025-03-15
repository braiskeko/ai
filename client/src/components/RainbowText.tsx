import { motion } from "framer-motion";

interface RainbowTextProps {
  text: string;
  className?: string;
}

export default function RainbowText({ text, className = "" }: RainbowTextProps) {
  return (
    <div className={`relative ${className}`}>
      {text.split("").map((char, i) => (
        <motion.span
          key={i}
          className="inline-block"
          animate={{
            color: [
              "rgb(100, 149, 237)", // Azul pastel
              "rgb(255, 176, 97)",  // Naranja pastel
              "rgb(144, 238, 144)", // Verde pastel
              "rgb(100, 149, 237)"  // Volver al azul pastel
            ]
          }}
          transition={{
            duration: 4, // Doubled the duration to make it slower
            repeat: Infinity,
            delay: i * 0.2 // Doubled the delay between letters
          }}
        >
          {char}
        </motion.span>
      ))}
    </div>
  );
}