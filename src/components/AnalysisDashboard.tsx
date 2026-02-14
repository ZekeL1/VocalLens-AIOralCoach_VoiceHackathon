interface AnalysisDashboardProps {
  accuracy: number | null;
  hint: string | null;
}

const AnalysisDashboard = ({ accuracy, hint }: AnalysisDashboardProps) => {
  return (
    <div className="w-full mt-4 grid gap-3 md:grid-cols-3">
      <div className="rounded-lg border border-border bg-card/60 p-4">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Accuracy Score
        </p>
        <p className="text-3xl font-semibold text-primary mt-1">
          {accuracy === null ? "--" : `${accuracy}%`}
        </p>
      </div>
      <div className="md:col-span-2 rounded-lg border border-border bg-card/60 p-4 min-h-[64px]">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Phoneme Coach
        </p>
        <p className="mt-1 text-sm text-card-foreground">
          {hint || "等待音频输入..."}
        </p>
      </div>
    </div>
  );
};

export default AnalysisDashboard;
