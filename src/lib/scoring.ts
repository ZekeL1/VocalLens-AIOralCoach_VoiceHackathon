export type TokenDiff = {
  word: string;
  status: "match" | "miss" | "extra";
  confidence: number | null;
};

export type PronunciationSignature = {
  overall: number;
  axes: Array<{ label: string; value: number }>;
};

type Mismatch = { ref?: string; hyp?: string };
type Op = "match" | "sub" | "ins" | "del";

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

export function diffWords(
  reference: string,
  hypothesis: string,
  hypothesisConfidences: Array<number | null> = []
) {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);

  const tokens: TokenDiff[] = [];
  const mismatches: Mismatch[] = [];
  let matches = 0;
  let substitutions = 0;
  let deletions = 0;
  let extras = 0;

  const n = ref.length;
  const m = hyp.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      ops.push("match");
      i--;
      j--;
      continue;
    }
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push("sub");
      i--;
      j--;
      continue;
    }
    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      ops.push("ins");
      j--;
      continue;
    }
    ops.push("del");
    i--;
  }
  ops.reverse();

  let ri = 0;
  let hi = 0;
  for (const op of ops) {
    if (op === "match") {
      const h = hyp[hi];
      const confidence = normalizeConfidence(hypothesisConfidences[hi]);
      hi++;
      ri++;
      tokens.push({ word: h, status: "match", confidence });
      matches++;
      continue;
    }
    if (op === "sub") {
      const r = ref[ri++];
      const h = hyp[hi];
      hi++;
      tokens.push({ word: h, status: "miss", confidence: null });
      mismatches.push({ ref: r, hyp: h });
      substitutions++;
      continue;
    }
    if (op === "ins") {
      const h = hyp[hi++];
      tokens.push({ word: h, status: "extra", confidence: null });
      mismatches.push({ hyp: h });
      extras++;
      continue;
    }
    const r = ref[ri++];
    mismatches.push({ ref: r });
    deletions++;
  }

  const referenceTotal = ref.length || 1;
  const spokenTotal = hyp.length || 1;
  const matchRate = matches / referenceTotal;
  const precision = matches / spokenTotal;

  const matchedConfidences = tokens
    .filter((t) => t.status === "match")
    .map((t) => normalizeConfidence(t.confidence))
    .filter((c): c is number => c !== null);
  const confidenceScore = matchedConfidences.length
    ? matchedConfidences.reduce((sum, c) => sum + c, 0) / matchedConfidences.length
    : 0.4;
  const highConfidenceMatches = matchedConfidences.filter((c) => c >= 0.88).length;
  const highConfidenceRate = matches > 0 ? highConfidenceMatches / matches : 0;
  const wer = (substitutions + deletions + extras) / referenceTotal;

  // Strict score: weighted correctness + confidence with strong WER/low-confidence penalties.
  const baseScore =
    (Math.pow(matchRate, 1.35) * 0.45 +
      Math.pow(precision, 1.2) * 0.25 +
      Math.pow(confidenceScore, 1.7) * 0.2 +
      highConfidenceRate * 0.1) *
    100;
  const errorPenalty = wer * 55 + Math.max(0, 0.9 - confidenceScore) * 25 + (1 - highConfidenceRate) * 20;
  let accuracy = Math.max(0, Math.min(100, baseScore - errorPenalty));

  // Keep top scores rare: only near-perfect reads should exceed 95.
  if (wer > 0.02 || confidenceScore < 0.94) accuracy = Math.min(accuracy, 96);
  if (wer > 0.08 || confidenceScore < 0.9) accuracy = Math.min(accuracy, 90);
  if (wer > 0.18) accuracy = Math.min(accuracy, 80);

  const signature = buildPronunciationSignature({
    accuracy,
    matchRate,
    confidenceScore,
    highConfidenceRate,
    wer,
    deletions,
    substitutions,
    extras,
    referenceTotal,
    spokenTotal,
  });

  return { tokens, accuracy, mismatches, signature };
}

function normalizeConfidence(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

const phonemeRules: Array<{
  ref: RegExp;
  hyp: RegExp;
  tip: string;
}> = [
  { ref: /^th/, hyp: /^d/, tip: "Possible /th/ -> /d/ substitution; place tongue lightly behind upper teeth." },
  { ref: /^v/, hyp: /^w/, tip: "Possible /v/ -> /w/; touch upper teeth to lower lip and voice the sound." },
  { ref: /^l/, hyp: /^r/, tip: "Possible /l/ -> /r/; keep tongue tip on alveolar ridge to avoid retroflex /r/." },
  { ref: /ing$/, hyp: /in$/, tip: "Possible /ng/ -> /n/; lift tongue back to seal the soft palate for /ng/." },
];

export function pickPhonemeHint(mismatches: Mismatch[]) {
  for (const m of mismatches) {
    if (!m.ref || !m.hyp) continue;
    for (const rule of phonemeRules) {
      if (rule.ref.test(m.ref) && rule.hyp.test(m.hyp)) {
        return rule.tip;
      }
    }
  }
  return null;
}

function buildPronunciationSignature(input: {
  accuracy: number;
  matchRate: number;
  confidenceScore: number;
  highConfidenceRate: number;
  wer: number;
  deletions: number;
  substitutions: number;
  extras: number;
  referenceTotal: number;
  spokenTotal: number;
}): PronunciationSignature {
  const completeness = 1 - input.deletions / input.referenceTotal;
  const correctness = 1 - input.substitutions / input.referenceTotal;
  const fluency = 1 - input.extras / input.spokenTotal;
  const strictness = Math.max(0, Math.min(1, input.accuracy / 100));
  const clarity = input.confidenceScore * 0.7 + input.highConfidenceRate * 0.3;
  const accuracyAxis = Math.max(0, strictness - input.wer * 0.3);

  const axes = [
    { label: "Accuracy", value: accuracyAxis },
    { label: "Clarity", value: clarity },
    { label: "Completeness", value: completeness },
    { label: "Correctness", value: correctness },
    { label: "Fluency", value: fluency },
  ].map((axis) => ({
    ...axis,
    value: Math.max(0, Math.min(1, axis.value)),
  }));

  const overall = axes.reduce((sum, axis) => sum + axis.value, 0) / axes.length;
  return { overall, axes };
}

