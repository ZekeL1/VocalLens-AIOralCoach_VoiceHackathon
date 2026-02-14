import { motion } from "framer-motion";

const sampleText = "The quick brown fox jumps over the lazy dog. This sentence contains every letter of the English alphabet and is commonly used for typing practice.";

const ReferenceText = () => {
  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="w-full"
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="h-px flex-1 bg-gradient-to-r from-primary/60 to-transparent" />
        <span className="font-display text-xs tracking-[0.3em] uppercase text-primary neon-text">
          Reference Text
        </span>
        <div className="h-px flex-1 bg-gradient-to-l from-primary/60 to-transparent" />
      </div>

      <div className="relative rounded-lg border border-border bg-card p-6 neon-border overflow-hidden">
        {/* Corner accents */}
        <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-primary rounded-tl-sm" />
        <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-primary rounded-tr-sm" />
        <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-primary rounded-bl-sm" />
        <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-primary rounded-br-sm" />

        <p className="text-lg md:text-xl leading-relaxed text-card-foreground font-light tracking-wide">
          {sampleText}
        </p>
      </div>
    </motion.div>
  );
};

export default ReferenceText;
