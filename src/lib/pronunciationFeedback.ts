import { supabase } from "@/integrations/supabase/client";

export interface PronunciationFeedbackIssue {
  word: string;
  problem: string;
  tip: string;
}

export interface PronunciationFeedback {
  summary: string;
  strengths: string[];
  issues: PronunciationFeedbackIssue[];
  drills: string[];
  overall_score: number;
}

export interface PronunciationFeedbackInput {
  sampleText: string;
  transcript: string;
  wordConfidences: Array<number | null>;
  accuracy: number | null;
  mismatches: Array<{ ref?: string; hyp?: string }>;
}

export const PRONUNCIATION_FEEDBACK_CACHE_KEY = "pronunciation_feedback_cache_v1";
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY as string | undefined;
const GROQ_MODEL = (import.meta.env.VITE_GROQ_MODEL as string | undefined) || "llama-3.1-8b-instant";

export async function requestPronunciationFeedback(
  input: PronunciationFeedbackInput
): Promise<PronunciationFeedback> {
  if (GROQ_API_KEY) {
    return requestPronunciationFeedbackViaGroq(input);
  }

  const { data, error } = await supabase.functions.invoke("groq-pronunciation-feedback", {
    body: input,
  });

  if (error) {
    throw new Error(error.message || "Failed to fetch pronunciation feedback");
  }

  const feedback = data as PronunciationFeedback;
  if (!feedback || typeof feedback.summary !== "string") {
    throw new Error("Invalid pronunciation feedback response");
  }
  return feedback;
}

export function cachePronunciationFeedback(
  input: PronunciationFeedbackInput,
  feedback: PronunciationFeedback
) {
  const payload = {
    updatedAt: new Date().toISOString(),
    input,
    feedback,
  };
  localStorage.setItem(PRONUNCIATION_FEEDBACK_CACHE_KEY, JSON.stringify(payload));
}

async function requestPronunciationFeedbackViaGroq(
  input: PronunciationFeedbackInput
): Promise<PronunciationFeedback> {
  const prompt = buildPrompt(input);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON generator. Return only valid JSON with requested keys and no markdown.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Groq request failed: ${detail}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonResponse(String(content));
  return sanitizeFeedback(parsed);
}

function buildPrompt(input: PronunciationFeedbackInput): string {
  const lowConfidenceWords = extractLowConfidenceWords(input.transcript, input.wordConfidences, 8);

  return [
    "You are an English pronunciation coach.",
    "Given a target sentence, ASR transcript, and confidence/mismatch signals, provide actionable pronunciation feedback.",
    "Respond strictly as JSON with this shape:",
    '{"summary":"string","strengths":["string"],"issues":[{"word":"string","problem":"string","tip":"string"}],"drills":["string"],"overall_score":0}',
    "Rules:",
    "- Keep summary <= 2 sentences.",
    "- strengths: 2-4 bullets.",
    "- issues: 2-6 concrete issues tied to pronunciation/articulation, not grammar.",
    "- drills: 2-5 short, specific drills.",
    "- overall_score: integer 0-100.",
    "",
    `Target text: ${input.sampleText}`,
    `ASR transcript: ${input.transcript}`,
    `Accuracy score: ${input.accuracy ?? "null"}`,
    `Mismatches: ${JSON.stringify(input.mismatches)}`,
    `Low confidence words: ${JSON.stringify(lowConfidenceWords)}`,
  ].join("\n");
}

function extractLowConfidenceWords(
  transcript: string,
  confidences: Array<number | null>,
  maxItems: number
): Array<{ word: string; confidence: number | null }> {
  const words = transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const rows = words.map((word, index) => ({
    word,
    confidence: normalizeConfidence(confidences[index]),
  }));

  return rows
    .sort((a, b) => {
      const ac = a.confidence ?? 1;
      const bc = b.confidence ?? 1;
      return ac - bc;
    })
    .slice(0, maxItems);
}

function normalizeConfidence(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

function parseJsonResponse(content: string) {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Empty model response");

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    throw new Error("Model response is not valid JSON");
  }
}

function sanitizeFeedback(payload: unknown): PronunciationFeedback {
  const record = payload as Record<string, unknown>;
  const issuesRaw = Array.isArray(record.issues) ? record.issues : [];

  const issues: PronunciationFeedbackIssue[] = issuesRaw
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        word: typeof row.word === "string" ? row.word : "",
        problem: typeof row.problem === "string" ? row.problem : "",
        tip: typeof row.tip === "string" ? row.tip : "",
      };
    })
    .filter((item) => item.word || item.problem || item.tip)
    .slice(0, 8);

  const strengths =
    Array.isArray(record.strengths) && record.strengths.length > 0
      ? record.strengths.filter((item): item is string => typeof item === "string").slice(0, 8)
      : [];
  const drills =
    Array.isArray(record.drills) && record.drills.length > 0
      ? record.drills.filter((item): item is string => typeof item === "string").slice(0, 8)
      : [];
  const rawScore = typeof record.overall_score === "number" ? record.overall_score : 0;

  return {
    summary: typeof record.summary === "string" ? record.summary : "",
    strengths,
    issues,
    drills,
    overall_score: Math.max(0, Math.min(100, Math.round(rawScore))),
  };
}
