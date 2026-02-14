import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface FeedbackInput {
  sampleText: string;
  transcript: string;
  wordConfidences: Array<number | null>;
  accuracy: number | null;
  mismatches: Array<{ ref?: string; hyp?: string }>;
}

function buildPrompt(input: FeedbackInput): string {
  const topLowConfidenceWords = extractLowConfidenceWords(input.transcript, input.wordConfidences, 8);

  return [
    "You are an English pronunciation coach.",
    "Given a target sentence, ASR transcript, and confidence/mismatch signals, provide actionable pronunciation feedback.",
    "Respond strictly as JSON with this shape:",
    '{"summary":"string","strengths":["string"],"issues":[{"word":"string","problem":"string","tip":"string"}],"drills":["string"],"overall_score":0}',
    "Rules:",
    "- Keep summary <= 2 sentences.",
    "- strengths: 2-4 bullets.",
    "- issues: 2-6 concrete issues tied to likely pronunciation/articulation, not grammar.",
    "- drills: 2-5 short, specific drills.",
    "- overall_score: integer 0-100.",
    "",
    `Target text: ${input.sampleText}`,
    `ASR transcript: ${input.transcript}`,
    `Accuracy score: ${input.accuracy ?? "null"}`,
    `Mismatches: ${JSON.stringify(input.mismatches)}`,
    `Low confidence words: ${JSON.stringify(topLowConfidenceWords)}`,
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

  const rows = words.map((word, i) => ({
    word,
    confidence: normalizeConfidence(confidences[i]),
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

function sanitizeFeedback(payload: any) {
  const summary = typeof payload?.summary === "string" ? payload.summary : "";
  const strengths = Array.isArray(payload?.strengths)
    ? payload.strengths.filter((x: unknown) => typeof x === "string").slice(0, 6)
    : [];
  const issues = Array.isArray(payload?.issues)
    ? payload.issues
        .map((x: any) => ({
          word: typeof x?.word === "string" ? x.word : "",
          problem: typeof x?.problem === "string" ? x.problem : "",
          tip: typeof x?.tip === "string" ? x.tip : "",
        }))
        .filter((x: { word: string; problem: string; tip: string }) => x.word || x.problem || x.tip)
        .slice(0, 8)
    : [];
  const drills = Array.isArray(payload?.drills)
    ? payload.drills.filter((x: unknown) => typeof x === "string").slice(0, 8)
    : [];
  const rawScore = typeof payload?.overall_score === "number" ? payload.overall_score : 0;
  const overall_score = Math.max(0, Math.min(100, Math.round(rawScore)));

  return {
    summary,
    strengths,
    issues,
    drills,
    overall_score,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const groqApiKey = Deno.env.get("GROQ_API_KEY");
    const groqModel = Deno.env.get("GROQ_MODEL") || "llama-3.1-8b-instant";

    if (!groqApiKey) {
      return new Response(JSON.stringify({ error: "GROQ_API_KEY is not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const input = (await req.json()) as FeedbackInput;
    if (!input?.sampleText || !input?.transcript) {
      return new Response(JSON.stringify({ error: "sampleText and transcript are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prompt = buildPrompt(input);

    const groqResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: groqModel,
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

    if (!groqResp.ok) {
      const detail = await groqResp.text();
      return new Response(JSON.stringify({ error: "Groq request failed", detail }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const groqJson = await groqResp.json();
    const content = groqJson?.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonResponse(String(content));
    const feedback = sanitizeFeedback(parsed);

    return new Response(JSON.stringify(feedback), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

