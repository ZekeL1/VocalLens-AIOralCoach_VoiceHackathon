import { motion, AnimatePresence } from "framer-motion";

interface TranscriptionDisplayProps {
  transcript: string;
  partialTranscript: string;
  tokens: { word: string; status: "match" | "miss" | "extra" }[];
  isConnected: boolean;
  isRecording: boolean;
}

const TranscriptionDisplay = ({
  transcript,
  partialTranscript,
  tokens,
  isConnected,
  isRecording,
}: TranscriptionDisplayProps) => {
  const hasContent = tokens.length > 0 || partialTranscript;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
      className="w-full"
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="h-px flex-1 bg-gradient-to-r from-accent/60 to-transparent" />
        <span className="themed-kicker font-display text-xs tracking-[0.3em] uppercase text-accent">
          Your Speech
        </span>
        <div className="h-px flex-1 bg-gradient-to-l from-accent/60 to-transparent" />
      </div>

      <div className="themed-textbox relative rounded-lg border border-border bg-card/50 p-6 min-h-[80px] overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-20" />

        <div className="relative z-10">
          <AnimatePresence mode="wait">
            {hasContent ? (
              <motion.p
                key="content"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="themed-copy text-lg leading-relaxed text-card-foreground font-light tracking-wide"
              >
                {tokens.map((t, idx) => (
                  <span
                    key={idx}
                    className={
                      t.status === "match"
                        ? "text-primary font-medium"
                        : t.status === "miss"
                        ? "text-destructive font-semibold"
                        : "text-muted-foreground"
                    }
                  >
                    {t.word}
                    {idx < tokens.length - 1 ? " " : ""}
                  </span>
                ))}
                {partialTranscript && (
                  <span className="text-muted-foreground italic">
                    {" "}
                    {partialTranscript}
                  </span>
                )}
              </motion.p>
            ) : (
              <motion.p
                key="placeholder"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.4 }}
                className="themed-copy text-lg leading-relaxed text-muted-foreground font-light tracking-wide italic"
              >
                {isRecording
                  ? "Listening..."
                  : "Start recording to see your speech transcribed here."}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Connection indicator */}
        {isRecording && (
          <div className="relative z-10 flex items-center gap-2 mt-4">
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                isConnected ? "bg-primary animate-pulse" : "bg-destructive"
              }`}
            />
            <span className="themed-kicker font-display text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
              {isConnected ? "ASR Connected" : "Connecting..."}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default TranscriptionDisplay;
