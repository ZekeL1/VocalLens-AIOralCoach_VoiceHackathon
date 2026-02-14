import { Mic, Square } from "lucide-react";
import { motion } from "framer-motion";

interface RecordButtonProps {
  isRecording: boolean;
  onToggle: () => void;
}

const RecordButton = ({ isRecording, onToggle }: RecordButtonProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.4 }}
      className="flex flex-col items-center gap-4"
    >
      <button
        onClick={onToggle}
        className={`
          relative w-20 h-20 rounded-full flex items-center justify-center
          transition-all duration-300 cursor-pointer
          border-2
          ${isRecording
            ? "bg-primary/20 border-primary neon-glow-strong animate-pulse-neon"
            : "bg-secondary border-border hover:border-primary/50 hover:neon-glow"
          }
        `}
      >
        {/* Outer ring animation when recording */}
        {isRecording && (
          <motion.div
            className="absolute inset-[-8px] rounded-full border border-primary/30"
            animate={{ scale: [1, 1.15, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
        )}

        {isRecording ? (
          <Square className="w-7 h-7 text-primary fill-primary" />
        ) : (
          <Mic className="w-8 h-8 text-primary" />
        )}
      </button>

      <span className="font-display text-xs tracking-[0.25em] uppercase text-muted-foreground">
        {isRecording ? (
          <span className="text-primary neon-text">Recording...</span>
        ) : (
          "Tap to Record"
        )}
      </span>
    </motion.div>
  );
};

export default RecordButton;
