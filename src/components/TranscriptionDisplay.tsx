import { motion, AnimatePresence } from "framer-motion";

interface TranscriptionDisplayProps {
  transcript: string;
  partialTranscript: string;
  tokens: { word: string; status: "match" | "miss" | "extra"; confidence: number | null }[];
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
  const hasContent = tokens.length > 0 || partialTranscript || transcript;

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
                        ? "font-medium"
                        : "text-destructive font-semibold"
                    }
                    style={t.status === "match" ? { color: colorFromConfidence(t.confidence) } : undefined}
                  >
                    {t.word}
                    {t.status === "match" && t.confidence !== null && (
                      <span className="ml-1 text-[10px] align-super text-muted-foreground opacity-70">
                        {formatConfidence(t.confidence)}
                      </span>
                    )}
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

function colorFromConfidence(confidence: number | null) {
  if (confidence === null) return "hsl(142 70% 45%)";

  const value = confidence <= 1 ? confidence * 100 : confidence;
  const percent = Math.max(0, Math.min(100, value));

  if (percent >= 98) return "hsl(142 82% 52%)"; // very high: bright green
  if (percent >= 95) return "hsl(130 84% 52%)"; // high: green
  if (percent >= 92) return "hsl(110 82% 52%)"; // still green
  if (percent >= 88) return "hsl(86 88% 54%)";  // yellow-green
  if (percent >= 82) return "hsl(58 92% 58%)";  // yellow
  if (percent >= 74) return "hsl(34 90% 58%)";  // yellow-orange
  return "hsl(8 86% 58%)"; // red-orange
}

function formatConfidence(confidence: number) {
  const percent = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(Math.max(0, Math.min(100, percent)))}%`;
}
