export type TokenDiff = {
  word: string;
  status: "match" | "miss" | "extra";
};

const strip = (w: string) => w.toLowerCase().replace(/[^\w']/g, "");

export function diffWords(reference: string, hypothesis: string) {
  const ref = reference
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const hyp = hypothesis
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const maxLen = hyp.length; // 只对比已读部分
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

  const accuracy = ref.length ? Math.max(0, Math.round((matches / ref.length) * 100)) : 0;

  return { tokens, accuracy, mismatches };
}

const phonemeRules: Array<{
  ref: RegExp;
  hyp: RegExp;
  tip: string;
}> = [
  { ref: /^th/, hyp: /^d/, tip: "检测到 /ð/ 发音异常，请注意舌尖轻触上齿背。" },
  { ref: /^v/, hyp: /^w/, tip: "可能把 /v/ 读成 /w/，上齿轻触下唇并振动声带。" },
  { ref: /^l/, hyp: /^r/, tip: "注意 /l/ 需舌尖抵上颚前部，避免卷舌成 /r/。" },
  { ref: /ing$/, hyp: /in$/, tip: "结尾 /ŋ/ 漏气成 /n/，舌根上抬封闭软腭。" },
];

export function pickPhonemeHint(mismatches: Array<{ ref?: string; hyp?: string }>) {
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
