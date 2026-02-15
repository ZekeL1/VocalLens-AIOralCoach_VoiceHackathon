const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

loadEnvFile(path.join(__dirname, ".env"));

const app = express();
const PORT = Number(process.env.PORT || 3001);
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const SMALLEST_AI_API_KEY = process.env.SMALLEST_AI_API_KEY || "";
const SMALLEST_TTS_VOICE_ID = process.env.SMALLEST_TTS_VOICE_ID || "";

app.use(express.json({ limit: "256kb" }));
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
    includePairs
      ? "Include a few common pronunciation challenge sounds like th, v/w, r/l, or ending -ng."
      : "Avoid tongue-twister style wording.",
    "Output plain sentence only. No quotes, no numbering, no explanation.",
  ].join(" ");

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.7,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              "You generate concise spoken-English practice content. Return only the final sentence text.",
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
    const text = sanitizeSentence(String(data?.choices?.[0]?.message?.content || ""));
    if (!text) {
      res.status(502).json({ error: "Model returned empty text" });
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
    "Analyze pronunciation quality by comparing REFERENCE and ASR output and confidence scores.",
    "Provide detailed but concise feedback in plain text for a learner.",
    "Output format:",
    "1) Overall assessment (1 sentence)",
    "2) Strengths (1-2 bullets)",
    "3) Issues to fix (2-4 bullets, mention likely words/sounds)",
    "4) Actionable drills (2-3 short drills)",
    "Keep total under 180 words. No markdown table.",
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
        temperature: 0.2,
        max_tokens: 360,
        messages: [
          {
            role: "system",
            content:
              "You are a strict but supportive pronunciation evaluator. Give practical, specific feedback.",
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
    const feedback = sanitizeSentenceBlock(String(data?.choices?.[0]?.message?.content || ""));
    if (!feedback) {
      res.status(502).json({ error: "Model returned empty feedback" });
      return;
    }

    res.json({
      feedback,
      avgConfidence,
      confidenceCount: normalizedConfidences.length,
    });
  } catch (error) {
    res.status(502).json({ error: "Groq request failed", detail: String(error) });
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
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return Math.max(min, Math.min(max, rounded));
}

function sanitizeSentence(input) {
  return String(input)
    .replace(/\r?\n/g, " ")
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSentenceBlock(input) {
  return String(input)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
