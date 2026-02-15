const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

loadEnvFile(path.join(__dirname, ".env"));

const app = express();
const PORT = Number(process.env.PORT || 3001);
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

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
