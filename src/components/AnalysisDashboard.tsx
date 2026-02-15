import type { PronunciationSignature as PronunciationSignatureType } from "@/lib/scoring";
import PronunciationSignature from "@/components/PronunciationSignature";

interface AnalysisDashboardProps {
  accuracy: number | null;
  hint: string | null;
  signature: PronunciationSignatureType | null;
}

const AnalysisDashboard = ({ accuracy, hint, signature }: AnalysisDashboardProps) => {
  return (
    <div className="w-full mt-4 grid gap-3 md:grid-cols-4">
      <div className="themed-textbox rounded-lg border border-border bg-card/60 p-4">
        <p className="themed-kicker text-xs uppercase tracking-[0.2em] text-muted-foreground">
          ASR Match
        </p>
        <p className="themed-copy text-3xl font-semibold text-primary mt-1">
          {accuracy === null ? "--" : `${accuracy.toFixed(1)}%`}
        </p>
      </div>
      <div className="themed-textbox md:col-span-2 rounded-lg border border-border bg-card/60 p-4 min-h-[64px]">
        <p className="themed-kicker text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Phoneme Coach
        </p>
        <p className="themed-copy mt-1 text-sm text-card-foreground">
          {hint || "Waiting for audio input..."}
        </p>
      </div>
      <div className="themed-textbox rounded-lg border border-border bg-card/60 p-4 min-h-[64px]">
        <p className="themed-kicker text-xs uppercase tracking-[0.2em] text-muted-foreground mb-2">
          Pronunciation SVG
        </p>
        <PronunciationSignature signature={signature} />
      </div>
    </div>
  );
};

export default AnalysisDashboard;
