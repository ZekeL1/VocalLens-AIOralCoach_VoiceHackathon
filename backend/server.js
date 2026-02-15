const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const express = require("express");

loadEnvFile(path.join(__dirname, ".env"));

const app = express();
const PORT = Number(process.env.PORT || 3001);
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const SMALLEST_AI_API_KEY = process.env.SMALLEST_AI_API_KEY || "";
const SMALLEST_TTS_VOICE_ID = process.env.SMALLEST_TTS_VOICE_ID || "";
const SPEECH_API_KEY = process.env.SPEECH_API_KEY || process.env.SPEECH_KEY || "";
const SPEECH_REGION = process.env.SPEECH_REGION || process.env.speech_region || "";
const DATA_DIR = path.join(__dirname, "data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const CACHE_FILE = path.join(DATA_DIR, "analysis-cache.json");

ensureDir(DATA_DIR);
ensureDir(AUDIO_DIR);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "30mb" }));
app.use("/saved-audio", express.static(AUDIO_DIR));
app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large") {
    res.status(413).json({
      error: "Request payload is too large",
      detail: "Audio payload exceeded backend JSON limit. Try shorter recording.",
    });
    return;
  }
  next(err);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/generate-reference-text", async (req, res) => {
  if (!GROQ_API_KEY) {
    res.status(500).json({ error: "GROQ_API_KEY is not configured in backend/.env" });
    return;
  }

  const lengthWords = clampInt(req.body?.lengthWords, 14, 40, 24);
  const level = String(req.body?.level || "b1").toLowerCase();
  const includePairs = req.body?.includeCommonPronunciationPairs ?? true;

  const prompt = [
    "Generate ONE short English speaking-practice sentence.",
    `Target ${lengthWords} words, CEFR level ${level.toUpperCase()}.`,
    "Keep it natural and easy to read aloud in one breath.",
    "avoid contractions.",
    includePairs
      ? "Include a few common pronunciation challenge sounds like th, v/w, r/l, or ending -ng."
      : "Avoid tongue-twister style wording and contractions.",
    "Output plain sentence only. No quotes, no numbering, no explanation.",
  ].join(" ");

  try {
    const firstPass = await requestSentenceFromGroq(prompt, GROQ_API_KEY, GROQ_MODEL);
    if (!firstPass.ok) {
      res.status(502).json({ error: "Groq request failed", detail: firstPass.detail });
      return;
    }

    let text = sanitizeSentence(firstPass.text);
    if (!text) {
      res.status(502).json({ error: "Model returned empty text" });
      return;
    }

    if (containsContraction(text)) {
      const retryPrompt =
        `${prompt} IMPORTANT: Return a sentence with ZERO contractions and ZERO apostrophes.`;
      const secondPass = await requestSentenceFromGroq(retryPrompt, GROQ_API_KEY, GROQ_MODEL);
      if (secondPass.ok) {
        const retried = sanitizeSentence(secondPass.text);
        if (retried && !containsContraction(retried)) {
          text = retried;
        }
      }
    }

    if (containsContraction(text)) {
      res.status(502).json({ error: "Model returned contractions; please retry." });
      return;
    }

    res.json({ text });
  } catch (error) {
    res.status(502).json({ error: "Groq request failed", detail: String(error) });
  }
});

app.post("/api/evaluate-pronunciation", async (req, res) => {
  if (!GROQ_API_KEY) {
    res.status(500).json({ error: "GROQ_API_KEY is not configured in backend/.env" });
    return;
  }

  const referenceText = String(req.body?.referenceText || "").trim();
  const asrText = String(req.body?.asrText || "").trim();
  const confidenceScores = Array.isArray(req.body?.confidenceScores)
    ? req.body.confidenceScores
    : [];
  const accuracy = Number.isFinite(Number(req.body?.accuracy))
    ? Number(req.body.accuracy)
    : null;

  if (!referenceText || !asrText) {
    res.status(400).json({ error: "referenceText and asrText are required" });
    return;
  }

  const normalizedConfidences = confidenceScores
    .map((value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      if (n > 1) return Math.max(0, Math.min(1, n / 100));
      return Math.max(0, Math.min(1, n));
    })
    .filter((value) => value !== null);

  const avgConfidence = normalizedConfidences.length
    ? normalizedConfidences.reduce((sum, value) => sum + value, 0) / normalizedConfidences.length
    : null;

  const prompt = [
    "You are an English pronunciation coach.",
    "Analyze only pronunciation weaknesses and return JSON only.",
    "No markdown, no prose outside JSON.",
    "JSON schema:",
    "{",
    '  "overall_score": number,',
    '  "axes": { "clarity": number, "stress_intonation": number, "consonant_precision": number, "vowel_quality": number, "fluency": number },',
    '  "critical_points": [string, string],',
    '  "action_drill": string,',
    '  "weak_words": [string]',
    "}",
    "Rules:",
    "- scores are numbers 0..100 (decimals allowed, keep 1 decimal place)",
    "- do not quantize scores to multiples of 5 or 10 unless evidence strongly supports it",
    "- critical_points must be specific pronunciation problems (e.g., th, r/l, v/w, -ng, stress)",
    "- keep action_drill under 18 words",
    "",
    `REFERENCE: ${referenceText}`,
    `ASR: ${asrText}`,
    `ACCURACY: ${accuracy === null ? "N/A" : `${accuracy.toFixed(1)}%`}`,
    `AVG_CONFIDENCE: ${avgConfidence === null ? "N/A" : avgConfidence.toFixed(3)}`,
    `CONFIDENCE_LIST: ${JSON.stringify(confidenceScores)}`,
  ].join("\n");

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: 260,
        messages: [
          {
            role: "system",
            content:
              "You are a strict pronunciation evaluator. Output valid JSON only. Keep scores granular and avoid coarse round numbers.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!groqRes.ok) {
      const detail = await groqRes.text();
      res.status(502).json({ error: "Groq request failed", detail });
      return;
    }

    const data = await groqRes.json();
    const raw = String(data?.choices?.[0]?.message?.content || "").trim();
    const parsed = safeParseJson(extractJsonObject(raw));
    if (!parsed) {
      res.status(502).json({ error: "Model returned empty feedback" });
      return;
    }

    const axesIn = parsed?.axes || {};
    const avgConfidencePercent = avgConfidence === null ? null : Math.round(avgConfidence * 100);
    const modelOverallRaw = Number(parsed?.overall_score);
    const overallFallback =
      accuracy === null
        ? (avgConfidencePercent === null ? 55 : avgConfidencePercent)
        : Math.round(accuracy);
    const overallScore = clampScore(
      Number.isFinite(modelOverallRaw) ? modelOverallRaw : null,
      0,
      100,
      overallFallback
    );
    const axes = {
      clarity: clampScore(axesIn?.clarity, 0, 100, avgConfidencePercent ?? overallScore),
      stress_intonation: clampScore(axesIn?.stress_intonation, 0, 100, Math.max(0, overallScore - 6)),
      consonant_precision: clampScore(axesIn?.consonant_precision, 0, 100, Math.max(0, overallScore - 10)),
      vowel_quality: clampScore(axesIn?.vowel_quality, 0, 100, Math.max(0, overallScore - 8)),
      fluency: clampScore(axesIn?.fluency, 0, 100, Math.max(0, overallScore - 4)),
    };
    const criticalPoints = Array.isArray(parsed?.critical_points)
      ? parsed.critical_points.map((x) => sanitizeSentence(String(x))).filter(Boolean).slice(0, 2)
      : [];
    const actionDrill = sanitizeSentence(String(parsed?.action_drill || ""));
    const weakWords = Array.isArray(parsed?.weak_words)
      ? parsed.weak_words.map((x) => sanitizeSentence(String(x))).filter(Boolean).slice(0, 6)
      : [];

    const feedback = [
      ...(criticalPoints.length ? criticalPoints.map((p) => `- Weakness: ${p}`) : ["- Weakness: needs clearer consonant targets."]),
      `- Action: ${actionDrill || "Repeat weak words slowly, then at natural speed."}`,
      ...(weakWords.length ? [`- Weak words: ${weakWords.join(", ")}`] : []),
    ].join("\n");

    res.json({
      feedback,
      overallScore,
      axes,
      criticalPoints,
      actionDrill,
      weakWords,
      avgConfidence,
      confidenceCount: normalizedConfidences.length,
    });
  } catch (error) {
    res.status(502).json({ error: "Groq request failed", detail: String(error) });
  }
});

app.post("/api/evaluate-pronunciation-azure", async (req, res) => {
  if (!SPEECH_API_KEY || !SPEECH_REGION) {
    res.status(500).json({ error: "SPEECH_API_KEY/SPEECH_REGION is not configured in backend/.env" });
    return;
  }

  const referenceText = String(req.body?.referenceText || "").trim();
  const wavBase64 = String(req.body?.wavBase64 || "").trim();
  const asrText = String(req.body?.asrText || "").trim();
  const accuracyInput = finiteOrNull(req.body?.accuracy);
  const confidenceScores = Array.isArray(req.body?.confidenceScores)
    ? req.body.confidenceScores
    : [];
  const normalizedConfidences = confidenceScores
    .map((value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      if (n > 1) return Math.max(0, Math.min(1, n / 100));
      return Math.max(0, Math.min(1, n));
    })
    .filter((value) => value !== null);
  const avgConfidence =
    normalizedConfidences.length > 0
      ? normalizedConfidences.reduce((sum, value) => sum + value, 0) / normalizedConfidences.length
      : null;
  if (!referenceText || !wavBase64) {
    res.status(400).json({ error: "referenceText and wavBase64 are required" });
    return;
  }

  const wavBuffer = Buffer.from(wavBase64, "base64");
  if (!wavBuffer.length) {
    res.status(400).json({ error: "Invalid wavBase64 payload" });
    return;
  }
  const audioHash = sha256Buffer(wavBuffer);
  const cacheKey = buildAnalysisCacheKey(audioHash, referenceText);
  const cached = getCachedAnalysis(cacheKey);
  if (cached) {
    console.log("[AzurePA] cache hit", {
      cacheKey,
      source: cached?.source || null,
      overallScore: cached?.overallScore ?? null,
    });
    res.json({
      ...cached,
      cacheHit: true,
      rawAzureApi: null,
    });
    return;
  }

  const paConfig = {
    ReferenceText: referenceText,
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    EnableMiscue: true,
    EnableProsodyAssessment: true,
  };
  const paHeader = Buffer.from(JSON.stringify(paConfig), "utf8").toString("base64");

  const url =
    `https://${SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=en-US&format=detailed`;

  try {
    const azureRes = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": SPEECH_API_KEY,
        "Pronunciation-Assessment": paHeader,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        Accept: "application/json",
      },
      body: wavBuffer,
    });

    if (!azureRes.ok) {
      const detail = await azureRes.text();
      const result = buildAzureFallbackResult({
        reason: "azure_http_error",
        detail,
        accuracyInput,
        avgConfidence,
        asrText,
      });
      res.json(finalizeAzureAnalysis({
        cacheKey,
        wavBuffer,
        audioHash,
        result,
      }));
      return;
    }

    const data = await azureRes.json();
    console.log("[AzurePA] raw response:");
    console.log(JSON.stringify(data, null, 2));
    const nbestList = Array.isArray(data?.NBest)
      ? data.NBest
      : Array.isArray(data?.nBest)
        ? data.nBest
        : [];
    const nbest = pickBestNBest(nbestList);
    const pa = nbest?.PronunciationAssessment || nbest?.pronunciationAssessment || {};
    const words = Array.isArray(nbest?.Words)
      ? nbest.Words
      : Array.isArray(nbest?.words)
        ? nbest.words
        : Array.isArray(data?.Words)
          ? data.Words
          : Array.isArray(data?.words)
            ? data.words
            : [];

    const accuracyCandidates = [
      pa?.AccuracyScore,
      nbest?.AccuracyScore,
      nbest?.accuracyScore,
      data?.AccuracyScore,
      data?.accuracyScore,
    ];
    const fluencyCandidates = [
      pa?.FluencyScore,
      nbest?.FluencyScore,
      nbest?.fluencyScore,
      data?.FluencyScore,
      data?.fluencyScore,
    ];
    const completenessCandidates = [
      pa?.CompletenessScore,
      nbest?.CompletenessScore,
      nbest?.completenessScore,
      data?.CompletenessScore,
      data?.completenessScore,
    ];
    const prosodyCandidates = [
      pa?.ProsodyScore,
      nbest?.ProsodyScore,
      nbest?.prosodyScore,
      data?.ProsodyScore,
      data?.prosodyScore,
    ];
    const accuracyRaw = pickBestScore(...accuracyCandidates);
    const fluencyRaw = pickBestScore(...fluencyCandidates);
    const completenessRaw = pickBestScore(...completenessCandidates);
    const prosodyRaw = pickBestScore(...prosodyCandidates);
    console.log("[AzurePA] score candidates", {
      accuracyCandidates,
      fluencyCandidates,
      completenessCandidates,
      prosodyCandidates,
      picked: {
        accuracyRaw,
        fluencyRaw,
        completenessRaw,
        prosodyRaw,
      },
    });

    const hasCoreScores =
      accuracyRaw !== null ||
      fluencyRaw !== null ||
      completenessRaw !== null ||
      prosodyRaw !== null;
    if (!hasCoreScores && words.length === 0) {
      const result = buildAzureFallbackResult({
        reason: "azure_no_metrics",
        detail: "Azure returned no pronunciation metrics",
        accuracyInput,
        avgConfidence,
        asrText,
      });
      res.json(finalizeAzureAnalysis({
        cacheKey,
        wavBuffer,
        audioHash,
        result,
      }));
      return;
    }

    const wordAccuracyScores = words
      .map((w) => pickBestScore(
        w?.PronunciationAssessment?.AccuracyScore,
        w?.pronunciationAssessment?.AccuracyScore,
        w?.AccuracyScore,
        w?.accuracyScore,
        w?.accuracy
      ))
      .filter((s) => s !== null);

    const wordAccuracyAvg = finiteOrNull(avg(wordAccuracyScores));
    const preferPositive = (primary, fallback) => {
      if (primary === null || primary === undefined) return fallback;
      if (primary > 0) return primary;
      if (fallback !== null && fallback !== undefined && fallback > 0) return fallback;
      return primary;
    };
    const overallCandidate = preferPositive(accuracyRaw, wordAccuracyAvg);
    const fluencySeed = fluencyRaw ?? prosodyRaw ?? completenessRaw;
    const fluencyCandidate = preferPositive(fluencySeed, wordAccuracyAvg);

    if (overallCandidate === null || fluencyCandidate === null) {
      const result = buildAzureFallbackResult({
        reason: "azure_incomplete_metrics",
        detail: "Could not derive overall/fluency from Azure response",
        accuracyInput,
        avgConfidence,
        asrText,
      });
      res.json(finalizeAzureAnalysis({
        cacheKey,
        wavBuffer,
        audioHash,
        result,
      }));
      return;
    }

    const isPartialAzure =
      accuracyRaw === null ||
      fluencyRaw === null ||
      prosodyRaw === null ||
      completenessRaw === null;

    const overallScore = clampScore(overallCandidate, 0, 100, 0);
    const fluencyScore = clampScore(fluencyCandidate, 0, 100, 0);
    const completenessScore = clampScore(completenessRaw, 0, 100, overallScore);
    const prosodyScore = clampScore(prosodyRaw, 0, 100, (overallScore + fluencyScore) / 2);
    const clarityScore = clampScore(avg(wordAccuracyScores), 0, 100, overallScore);

    const phonemes = words.flatMap((w) => {
      if (Array.isArray(w?.Phonemes)) return w.Phonemes;
      if (Array.isArray(w?.phonemes)) return w.phonemes;
      return [];
    });
    const consonantScores = [];
    const vowelScores = [];
    for (const p of phonemes) {
      const score = pickBestScore(
        p?.PronunciationAssessment?.AccuracyScore,
        p?.pronunciationAssessment?.AccuracyScore,
        p?.AccuracyScore,
        p?.accuracyScore,
        p?.accuracy
      );
      if (score === null) continue;
      const phone = String(p?.Phoneme || p?.phoneme || "").toUpperCase();
      if (isVowelPhone(phone)) vowelScores.push(score);
      else consonantScores.push(score);
    }

    const consonantScore = clampScore(avg(consonantScores), 0, 100, overallScore);
    const vowelScore = clampScore(avg(vowelScores), 0, 100, overallScore);

    const weakWords = words
      .filter((w) => {
        const s = pickBestScore(
          w?.PronunciationAssessment?.AccuracyScore,
          w?.pronunciationAssessment?.AccuracyScore,
          w?.AccuracyScore,
          w?.accuracyScore,
          w?.accuracy
        );
        const err = String(
          w?.PronunciationAssessment?.ErrorType ||
          w?.pronunciationAssessment?.ErrorType ||
          w?.ErrorType ||
          w?.errorType ||
          ""
        ).toLowerCase();
        return (s !== null && s < 70) || (err && err !== "none");
      })
      .slice(0, 6)
      .map((w) => String(w?.Word || w?.word || "").toLowerCase())
      .filter(Boolean);

    const wordScores = words
      .map((w, index) => {
        const word = String(w?.Word || w?.word || "").toLowerCase().trim();
        const accuracy = pickBestScore(
          w?.PronunciationAssessment?.AccuracyScore,
          w?.pronunciationAssessment?.AccuracyScore,
          w?.AccuracyScore,
          w?.accuracyScore,
          w?.accuracy
        );
        const errorTypeRaw = String(
          w?.PronunciationAssessment?.ErrorType ||
          w?.pronunciationAssessment?.ErrorType ||
          w?.ErrorType ||
          w?.errorType ||
          ""
        ).trim();
        const errorType = errorTypeRaw && errorTypeRaw.toLowerCase() !== "none" ? errorTypeRaw : null;
        return {
          index,
          word,
          accuracy,
          errorType,
        };
      })
      .filter((x) => x.word && x.accuracy !== null);

    const weakWordDetails = [...wordScores]
      .filter((x) => (x.accuracy !== null && x.accuracy < 75) || x.errorType)
      .sort((a, b) => Number(a.accuracy) - Number(b.accuracy))
      .slice(0, 12);

    const weakPhonemes = phonemes
      .map((p) => ({
        phone: String(p?.Phoneme || ""),
        score: pickBestScore(
          p?.PronunciationAssessment?.AccuracyScore,
          p?.pronunciationAssessment?.AccuracyScore,
          p?.AccuracyScore,
          p?.accuracyScore,
          p?.accuracy
        ),
      }))
      .filter((x) => x.phone && x.score !== null && x.score < 70)
      .sort((a, b) => a.score - b.score)
      .slice(0, 5)
      .map((x) => x.phone.toUpperCase());

    const fallbackCriticalPoints = deriveCriticalPoints({
      overallScore,
      consonantScore,
      vowelScore,
      prosodyScore,
      fluencyScore,
      weakPhonemes,
      weakWords,
    });
    const fallbackActionDrill = deriveActionDrill(weakPhonemes, weakWords);

    let criticalPoints = fallbackCriticalPoints;
    let actionDrill = fallbackActionDrill;
    let feedback = [
      `- Weakness: ${criticalPoints[0]}`,
      `- Weakness: ${criticalPoints[1]}`,
      `- Action: ${actionDrill}`,
      weakWords.length ? `- Weak words: ${weakWords.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = {
      source: isPartialAzure ? "azure_partial" : "azure",
      feedback,
      overallScore,
      axes: {
        clarity: clarityScore,
        stress_intonation: prosodyScore,
        consonant_precision: consonantScore,
        vowel_quality: vowelScore,
        fluency: fluencyScore,
        completeness: completenessScore,
      },
      criticalPoints,
      actionDrill,
      weakWords,
      weakWordDetails,
      wordScores: wordScores.slice(0, 80),
      weakPhonemes,
      rawAzure: {
        recognitionStatus: data?.RecognitionStatus || null,
        displayText: data?.DisplayText || null,
      },
      azureDebug: {
        nbestCount: nbestList.length,
        selectedNBestIndex: nbest ? nbestList.indexOf(nbest) : -1,
        scoreCandidates: {
          accuracy: accuracyCandidates,
          fluency: fluencyCandidates,
          completeness: completenessCandidates,
          prosody: prosodyCandidates,
        },
        picked: {
          accuracyRaw,
          fluencyRaw,
          completenessRaw,
          prosodyRaw,
          wordAccuracyAvg,
        },
      },
    };
    const finalized = finalizeAzureAnalysis({
      cacheKey,
      wavBuffer,
      audioHash,
      result,
    });
    res.json({
      ...finalized,
      cacheHit: false,
      rawAzureApi: data,
    });
  } catch (error) {
    const result = buildAzureFallbackResult({
      reason: "azure_exception",
      detail: String(error),
      accuracyInput,
      avgConfidence,
      asrText,
    });
    res.json(finalizeAzureAnalysis({
      cacheKey,
      wavBuffer,
      audioHash,
      result,
    }));
  }
});

app.post("/api/speak-feedback", async (req, res) => {
  if (!SMALLEST_AI_API_KEY) {
    res.status(500).json({ error: "SMALLEST_AI_API_KEY is not configured in backend/.env" });
    return;
  }

  const text = String(req.body?.text || "").trim();
  const voiceId = String(req.body?.voiceId || SMALLEST_TTS_VOICE_ID).trim();
  const speed = Number.isFinite(Number(req.body?.speed)) ? Number(req.body.speed) : 1;
  const sampleRate = Number.isFinite(Number(req.body?.sampleRate))
    ? Number(req.body.sampleRate)
    : 24000;

  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  if (!voiceId) {
    res.status(400).json({ error: "voiceId is required (or set SMALLEST_TTS_VOICE_ID)" });
    return;
  }

  try {
    const ttsRes = await fetch("https://waves-api.smallest.ai/api/v1/lightning-v2/get_speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SMALLEST_AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        sample_rate: sampleRate,
        speed: Math.max(0.5, Math.min(2, speed)),
        language: "en",
        output_format: "wav",
      }),
    });

    if (!ttsRes.ok) {
      const detail = await ttsRes.text();
      res.status(502).json({ error: "Smallest TTS request failed", detail });
      return;
    }

    const audioBuffer = await ttsRes.arrayBuffer();
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(Buffer.from(audioBuffer));
  } catch (error) {
    res.status(502).json({ error: "Smallest TTS request failed", detail: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
});

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return Math.max(min, Math.min(max, rounded));
}

function clampScore(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(min, Math.min(max, n));
  return Number(clamped.toFixed(1));
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toScoreCandidate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    value = trimmed;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

function pickBestScore(...values) {
  const finiteValues = values
    .map((value) => toScoreCandidate(value))
    .filter((n) => n !== null);
  if (!finiteValues.length) return null;
  const positiveValues = finiteValues.filter((n) => n > 0);
  if (positiveValues.length) return Math.max(...positiveValues);
  // Azure sometimes returns duplicate score fields where one path is 0 and another has the real value.
  // Pick the highest finite score to avoid false zero-selection.
  return Math.max(...finiteValues);
}

function pickBestNBest(nbestList) {
  if (!Array.isArray(nbestList) || !nbestList.length) return null;
  let best = nbestList[0];
  let bestValue = -1;

  for (const candidate of nbestList) {
    const pa = candidate?.PronunciationAssessment || candidate?.pronunciationAssessment || {};
    const candidateScore = pickBestScore(
      pa?.AccuracyScore,
      pa?.FluencyScore,
      pa?.CompletenessScore,
      pa?.ProsodyScore,
      candidate?.AccuracyScore,
      candidate?.accuracyScore,
      candidate?.FluencyScore,
      candidate?.fluencyScore,
      candidate?.CompletenessScore,
      candidate?.completenessScore,
      candidate?.ProsodyScore,
      candidate?.prosodyScore
    );
    const rankingScore = candidateScore === null ? -1 : candidateScore;
    if (rankingScore > bestValue) {
      bestValue = rankingScore;
      best = candidate;
    }
  }

  return best;
}

function buildAzureFallbackResult(input) {
  const base = clampScore(input.accuracyInput, 0, 100, input.avgConfidence === null ? 58 : input.avgConfidence * 100);
  const clarity = clampScore(input.avgConfidence === null ? null : input.avgConfidence * 100, 0, 100, base);
  const stress = clampScore(base - 8, 0, 100, 50);
  const consonants = clampScore(base - 12, 0, 100, 46);
  const vowels = clampScore(base - 10, 0, 100, 48);
  const fluency = clampScore(base - 6, 0, 100, 52);
  const weakWords = String(input.asrText || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);

  return {
    source: "azure_fallback",
    feedback: "- Azure scoring was temporarily unavailable.\n- Action: Speak a full sentence clearly and try Finish again.",
    overallScore: base,
    axes: {
      clarity,
      stress_intonation: stress,
      consonant_precision: consonants,
      vowel_quality: vowels,
      fluency,
    },
    criticalPoints: ["Azure metric extraction failed on this attempt."],
    actionDrill: "Read the sentence once slowly, then once at natural speed.",
    weakWords,
    weakWordDetails: [],
    wordScores: [],
    weakPhonemes: [],
    rawAzure: {
      reason: input.reason,
      detail: input.detail || null,
    },
  };
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeForCache(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAnalysisCacheKey(audioHash, referenceText) {
  return `${audioHash}:${normalizeForCache(referenceText)}`;
}

function readAnalysisCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAnalysisCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (error) {
    console.warn("[backend] failed to write analysis cache:", String(error));
  }
}

function getCachedAnalysis(cacheKey) {
  const cache = readAnalysisCache();
  const entry = cache[cacheKey];
  if (!entry || typeof entry !== "object") return null;
  return entry.result || null;
}

function finalizeAzureAnalysis(input) {
  const timestamp = new Date().toISOString();
  const audioFileName = `${input.audioHash}.wav`;
  const audioFilePath = path.join(AUDIO_DIR, audioFileName);

  try {
    if (!fs.existsSync(audioFilePath)) {
      fs.writeFileSync(audioFilePath, input.wavBuffer);
    }
  } catch (error) {
    console.warn("[backend] failed to persist audio file:", String(error));
  }

  const resultWithMeta = {
    ...input.result,
    audioHash: input.audioHash,
    audioFile: path.join("backend", "data", "audio", audioFileName),
    audioUrl: `/saved-audio/${audioFileName}`,
    cachedAt: timestamp,
  };

  const cache = readAnalysisCache();
  cache[input.cacheKey] = {
    createdAt: timestamp,
    result: resultWithMeta,
  };
  writeAnalysisCache(cache);
  return resultWithMeta;
}

function sanitizeSentence(input) {
  return String(input)
    .replace(/\r?\n/g, " ")
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonObject(raw) {
  const text = String(raw || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function avg(values) {
  if (!Array.isArray(values) || !values.length) return null;
  return values.reduce((s, v) => s + Number(v || 0), 0) / values.length;
}

function isVowelPhone(phone) {
  const vowels = new Set([
    "AA", "AE", "AH", "AO", "AW", "AX", "AY",
    "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW",
  ]);
  return vowels.has(String(phone || "").replace(/[0-9]/g, ""));
}

function deriveCriticalPoints(input) {
  const points = [];
  if (input.prosodyScore < 75) points.push("Stress and intonation are flat in key phrases.");
  if (input.consonantScore < 75) points.push("Consonant precision is weak (th/r/l/v/w clusters).");
  if (input.vowelScore < 75) points.push("Vowel shape/length is inconsistent on stressed syllables.");
  if (input.fluencyScore < 75) points.push("Rhythm has pauses/restarts that reduce natural flow.");
  if (!points.length && input.weakPhonemes.length) {
    points.push(`Frequent weak phonemes: ${input.weakPhonemes.slice(0, 3).join(", ")}.`);
  }
  if (!points.length && input.weakWords.length) {
    points.push(`Pronunciation is unclear on: ${input.weakWords.slice(0, 3).join(", ")}.`);
  }
  while (points.length < 2) {
    points.push("Pronunciation is understandable, but consistency drops on harder sounds.");
  }
  return points.slice(0, 2);
}

function deriveActionDrill(weakPhonemes, weakWords) {
  if (weakPhonemes.includes("TH")) {
    return "Practice TH: think, three, thank slowly; then say full sentence at natural speed.";
  }
  if (weakPhonemes.includes("R") || weakPhonemes.includes("L")) {
    return "Alternate right-light, road-load, really-lily for 2 minutes, then reread the sentence.";
  }
  if (weakPhonemes.includes("V") || weakPhonemes.includes("W")) {
    return "Practice vine-wine, vest-west, very-wary with clear lip-teeth contact for V.";
  }
  if (weakWords.length) {
    return `Repeat weak words slowly 3x each: ${weakWords.slice(0, 3).join(", ")}.`;
  }
  return "Read once slowly, mark stressed words, then reread with stronger rhythm and clearer consonants.";
}

function containsContraction(text) {
  const s = String(text).toLowerCase();
  return /\b(?:\w+n't|\w+'re|\w+'ve|\w+'ll|\w+'d|i'm|it's|that's|there's|here's|what's|who's|where's|when's|why's|how's|let's)\b/.test(
    s
  );
}

async function requestSentenceFromGroq(prompt, apiKey, model) {
  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content:
            "You generate concise spoken-English practice content. Return only one sentence and do not use contractions.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!groqRes.ok) {
    return { ok: false, detail: await groqRes.text() };
  }

  const data = await groqRes.json();
  const text = String(data?.choices?.[0]?.message?.content || "");
  return { ok: true, text };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const raw = trimmed.slice(eqIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, "");
  }
}
