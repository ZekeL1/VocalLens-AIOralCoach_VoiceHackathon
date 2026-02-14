export type TokenDiff = {
  word: string;
  status: "match" | "miss" | "extra";
};

export function diffWords(reference: string, hypothesis: string) {
  const refAll = reference
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const hyp = hypothesis
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Compare only against the same-length prefix of the reference text.
  const ref = refAll.slice(0, hyp.length);
  const maxLen = hyp.length;

  const tokens: TokenDiff[] = [];
  let matches = 0;
  const mismatches: Array<{ ref?: string; hyp?: string }> = [];

  for (let i = 0; i < maxLen; i++) {
    const r = ref[i];
    const h = hyp[i];

    if (r && h) {
      if (r === h) {
        tokens.push({ word: h, status: "match" });
        matches++;
      } else {
        tokens.push({ word: h, status: "miss" });
        mismatches.push({ ref: r, hyp: h });
      }
    } else if (!r && h) {
      tokens.push({ word: h, status: "extra" });
      mismatches.push({ ref: undefined, hyp: h });
    }
  }

  const accuracyBase = ref.length;
  const accuracy = accuracyBase ? Math.max(0, Math.round((matches / accuracyBase) * 100)) : 0;

  return { tokens, accuracy, mismatches };
}

const phonemeRules: Array<{
  ref: RegExp;
  hyp: RegExp;
  tip: string;
}> = [
  {
    ref: /^th/,
    hyp: /^d/,
    tip: "Possible /th/ to /d/ substitution; place your tongue lightly behind the upper teeth.",
  },
  {
    ref: /^v/,
    hyp: /^w/,
    tip: "Possible /v/ to /w/ substitution; touch upper teeth to lower lip and keep voicing.",
  },
  {
    ref: /^l/,
    hyp: /^r/,
    tip: "Possible /l/ to /r/ substitution; keep the tongue tip on the alveolar ridge.",
  },
  {
    ref: /ing$/,
    hyp: /in$/,
    tip: "Possible /ng/ to /n/ ending shift; lift the back of the tongue for /ng/.",
  },
];

export function pickPhonemeHint(mismatches: Array<{ ref?: string; hyp?: string }>) {
  for (const mismatch of mismatches) {
    if (!mismatch.ref || !mismatch.hyp) continue;

    for (const rule of phonemeRules) {
      if (rule.ref.test(mismatch.ref) && rule.hyp.test(mismatch.hyp)) {
        return rule.tip;
      }
    }
  }

  return null;
}
