import { useState } from "react";
import type { PronunciationSignature as PronunciationSignatureType } from "@/lib/scoring";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface PronunciationSignatureProps {
  signature: PronunciationSignatureType | null;
}

const SIZE = 180;
const CENTER = SIZE / 2;
const MAX_RADIUS = 64;

const PronunciationSignature = ({ signature }: PronunciationSignatureProps) => {
  const [open, setOpen] = useState(false);

  if (!signature || signature.axes.length < 3) {
    return (
      <div className="text-xs text-muted-foreground">
        Finish the session to generate pronunciation analysis SVG.
      </div>
    );
  }

  const points = signature.axes.map((axis, i, arr) => {
    const angle = (Math.PI * 2 * i) / arr.length - Math.PI / 2;
    const radius = MAX_RADIUS * axis.value;
    const x = CENTER + Math.cos(angle) * radius;
    const y = CENTER + Math.sin(angle) * radius;
    return { ...axis, angle, x, y };
  });

  const axisDescriptions: Record<string, string> = {
    Accuracy: "Overall strict score",
    Clarity: "Pronunciation clarity and consistency",
    "Stress/Intonation": "Sentence rhythm and emphasis",
    Consonants: "Precision of consonant sounds (th, r/l, v/w, etc.)",
    Vowels: "Vowel shape and length quality",
    Fluency: "Flow without breaks/restarts",
    Completeness: "How many reference words you covered",
    Correctness: "How many words were pronounced as expected",
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md p-1 hover:bg-primary/5 transition-colors"
        title="Click to enlarge"
      >
        {renderSignatureSvg(points, SIZE, CENTER, MAX_RADIUS, false)}
      </button>

      <p className="text-xs tracking-wide text-muted-foreground">
        Signature {(signature.overall * 100).toFixed(2)}% (click to zoom)
      </p>

      <div className="w-full space-y-1">
        {signature.axes.map((axis) => (
          <div key={axis.label} className="text-[11px] leading-tight">
            <span className="text-foreground font-medium">{axis.label}:</span>{" "}
            <span className="text-muted-foreground">
              {(axis.value * 100).toFixed(2)}% - {axisDescriptions[axis.label] || "Pronunciation metric"}
            </span>
          </div>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[520px] border-border bg-card/95">
          <DialogHeader>
            <DialogTitle>Pronunciation Signature</DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-2">
            {renderSignatureSvg(points, 420, 210, 150, true)}
          </div>
          <div className="grid gap-1">
            {signature.axes.map((axis) => (
              <p key={axis.label} className="text-sm text-card-foreground">
                <span className="font-semibold">{axis.label}</span>: {(axis.value * 100).toFixed(2)}% -{" "}
                {axisDescriptions[axis.label] || "Pronunciation metric"}
              </p>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PronunciationSignature;

function renderSignatureSvg(
  points: Array<{ label: string; value: number; angle: number }>,
  size: number,
  center: number,
  maxRadius: number,
  showAxisLabels: boolean
) {
  const rings = [0.25, 0.5, 0.75, 1];
  const projectedPoints = points.map((p) => {
    const radius = maxRadius * p.value;
    return {
      ...p,
      x: center + Math.cos(p.angle) * radius,
      y: center + Math.sin(p.angle) * radius,
    };
  });
  const polygon = projectedPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Pronunciation signature">
      {rings.map((r) => (
        <circle
          key={r}
          cx={center}
          cy={center}
          r={maxRadius * r}
          fill="none"
          stroke="hsl(var(--border))"
          strokeOpacity={0.35}
          strokeWidth="1"
        />
      ))}

      {projectedPoints.map((p) => (
        <line
          key={p.label}
          x1={center}
          y1={center}
          x2={center + Math.cos(p.angle) * maxRadius}
          y2={center + Math.sin(p.angle) * maxRadius}
          stroke="hsl(var(--border))"
          strokeOpacity={0.5}
          strokeWidth="1"
        />
      ))}

      <polygon points={polygon} fill="hsl(var(--primary))" fillOpacity={0.22} stroke="hsl(var(--primary))" strokeWidth="2" />

      {showAxisLabels &&
        projectedPoints.map((p) => {
          const labelRadius = maxRadius + 20;
          const lx = center + Math.cos(p.angle) * labelRadius;
          const ly = center + Math.sin(p.angle) * labelRadius;
          return (
            <text
              key={`label-${p.label}`}
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="hsl(var(--muted-foreground))"
              fontSize="12"
            >
              {shortAxisLabel(p.label)}
            </text>
          );
        })}
    </svg>
  );
}

function shortAxisLabel(label: string) {
  if (label === "Stress/Intonation") return "Stress";
  return label;
}
