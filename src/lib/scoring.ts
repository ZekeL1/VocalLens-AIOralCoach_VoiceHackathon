export type TokenDiff = {
  word: string;
  status: "match" | "miss" | "extra";
  confidence: number | null;
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
  let misses = 0;
  let extras = 0;
  let matchedConfidenceSum = 0;
  let matchedConfidenceCount = 0;

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
      const rawConfidence = normalizeConfidence(hypothesisConfidences[hi]);
      const confidence = compressConfidence(rawConfidence);
      hi++;
      ri++;
      tokens.push({ word: h, status: "match", confidence });
      if (confidence !== null) {
        matchedConfidenceSum += confidence;
        matchedConfidenceCount++;
      }
      matches++;
      continue;
    }
    if (op === "sub") {
      const r = ref[ri++];
      const h = hyp[hi];
      hi++;
      tokens.push({ word: h, status: "miss", confidence: null });
      mismatches.push({ ref: r, hyp: h });
      misses++;
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
    misses++;
  }

  const weightedErrors = (misses + extras)* 1.25;
  const baseAccuracy =
    matches + weightedErrors > 0 ? matches / (matches + weightedErrors) : 0;
  const strictAccuracy = strictScoreFromBase(baseAccuracy);
  const avgMatchedConfidence =
    matchedConfidenceCount > 0 ? matchedConfidenceSum / matchedConfidenceCount : null;
  const confidenceAdjusted = applyConfidenceToScore(strictAccuracy, avgMatchedConfidence);
  const accuracy = applyHighScoreCurve(confidenceAdjusted);
  return { tokens, accuracy, mismatches };
}

function strictScoreFromBase(baseAccuracy: number) {
  const clamped = Math.max(0, Math.min(1, baseAccuracy));
  const strict = Math.pow(clamped, 1.45);
  return strict * 100;
}

function applyConfidenceToScore(score: number, avgConfidence: number | null) {
  if (avgConfidence === null) return score;
  // Multiplier range: 0.55 - 1.00
  const multiplier = 0.55 + 0.45 * Math.max(0, Math.min(1, avgConfidence));
  return Math.max(0, Math.min(100, score * multiplier));
}

function applyHighScoreCurve(score: number) {
  let curved = Math.max(0, Math.min(100, score));
  // Progressive compression: higher score bands are increasingly harder.
  curved = compressAbove(curved, 70, 0.78);
  curved = compressAbove(curved, 85, 0.62);
  curved = compressAbove(curved, 93, 0.4);
  return curved;
}

function compressAbove(value: number, pivot: number, factor: number) {
  if (value <= pivot) return value;
  return pivot + (value - pivot) * factor;
}

function normalizeConfidence(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

function compressConfidence(value: number | null) {
  if (value === null) return null;
  // Preserve perfect confidence at word-level.
  if (value >= 0.999999) return 1;
  // Word-level confidence shown in UI uses the same compressed scale as scoring.
  return Math.max(0, Math.min(1, value - 0.12));
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
  return "Overall, your pronunciation is quite good. Keep up the great work and stay consistent.";
}
