import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import ReferenceText from "@/components/ReferenceText";
import Waveform from "@/components/Waveform";
import RecordButton from "@/components/RecordButton";
import TranscriptionDisplay from "@/components/TranscriptionDisplay";
import { useASR } from "@/hooks/useASR";
import AnalysisDashboard from "@/components/AnalysisDashboard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { diffWords, pickPhonemeHint } from "@/lib/scoring";
import { sampleText } from "@/components/ReferenceText";
import { useToast } from "@/hooks/use-toast";
import type { PronunciationSignature } from "@/lib/scoring";

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || "http://localhost:3001").replace(/\/+$/, "");

const Index = () => {
  const [theme, setTheme] = useState<
    "neon" | "minimal" | "trendy" | "accessible"
  >("neon");
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFinishDialogOpen, setIsFinishDialogOpen] = useState(false);
  const [isEvaluatingPronunciation, setIsEvaluatingPronunciation] = useState(false);
  const [isReadingEvaluation, setIsReadingEvaluation] = useState(false);
  const [finishSummary, setFinishSummary] = useState<{
    score: number | null;
    hint: string | null;
  }>({ score: null, hint: null });
  const [wordDiagnostics, setWordDiagnostics] = useState<
    Array<{ word: string; accuracy: number; errorType: string | null }>
  >([]);
  const [modelSignature, setModelSignature] = useState<PronunciationSignature | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [referenceText, setReferenceText] = useState(sampleText.trim());
  const [isGeneratingReference, setIsGeneratingReference] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const hasSpokenPromptRef = useRef(false);
  const evaluationAudioRef = useRef<HTMLAudioElement | null>(null);
  const evaluationAudioPrimaryUrlRef = useRef<string | null>(null);
  const evaluationAudioSecondaryUrlRef = useRef<string | null>(null);
  const playbackSessionRef = useRef(0);
  const ttsAbortControllersRef = useRef<AbortController[]>([]);
  const { toast } = useToast();

  const {
    transcript,
    partialTranscript,
    wordConfidences,
    isConnected,
    audioBuffers,
    audioDuration,
    startASR,
    pauseASR,
    resumeASR,
    stopASR,
    resetTranscript,
    getRecordedWavBase64,
  } = useASR();

  const hasFinalSpeech = transcript.trim().length > 0;
  const analysis = hasFinalSpeech
    ? diffWords(referenceText, transcript, wordConfidences)
    : { tokens: [], accuracy: 0, mismatches: [] };
  const hint = hasFinalSpeech ? pickPhonemeHint(analysis.mismatches) : null;
  const displayedAdvice = isEvaluatingPronunciation
    ? "Analyzing pronunciation with Groq..."
    : finishSummary.hint || "No advice available yet. Try another recording.";
  const adviceSections = useMemo(() => {
    const raw = displayedAdvice.replace(/\r/g, "").trim();
    if (!raw) return [];
    if (raw === "Analyzing pronunciation with Groq...") return [raw];

    const normalized = raw
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s*\n\s*/g, "\n")
      .trim();

    const withSectionBreaks = normalized.replace(
      /(\b(?:overall assessment|strengths?|issues? to fix|actionable drills?)\b\s*[:：-]?)/gi,
      "\n$1"
    );
    const bySectionLabel = withSectionBreaks
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const sections = (bySectionLabel.length > 1 ? bySectionLabel : normalized.split(/\n\n+/))
      .map((s) => s.replace(/^\d+[\)\.\-:]\s*/, "").trim())
      .filter(Boolean);
    return sections.length ? sections : [raw];
  }, [displayedAdvice]);

  const resetSession = useCallback(() => {
    stopASR();
    mediaRecorderRef.current?.stop();
    mediaStream?.getTracks().forEach((t) => t.stop());
    setMediaStream(null);
    setIsRecording(false);
    setIsPaused(false);
    setIsFinishDialogOpen(false);
    setWordDiagnostics([]);
    setModelSignature(null);
    resetTranscript();
  }, [mediaStream, stopASR, resetTranscript]);


  const finishSession = useCallback(() => {
    const score = hasFinalSpeech ? analysis.accuracy : null;
    const fallbackHint = hint || "No advice available yet. Try another recording.";
    setFinishSummary({
      score,
      hint: hasFinalSpeech ? "Analyzing pronunciation with Groq..." : fallbackHint,
    });

    const transcriptSnapshot = transcript.trim();
    const referenceSnapshot = referenceText.trim();
    const confidenceSnapshot = [...wordConfidences];

    stopASR();
    const wavBase64 = getRecordedWavBase64(20);
    mediaRecorderRef.current?.stop();
    mediaStream?.getTracks().forEach((t) => t.stop());
    setMediaStream(null);
    setIsRecording(false);
    setIsPaused(false);
    setIsFinishDialogOpen(true);
    if (!transcriptSnapshot) return;

    setWordDiagnostics([]);
    setModelSignature(null);
    setIsEvaluatingPronunciation(true);
    void (async () => {
      try {
        let usedAzureScore = false;
        const parseErrorDetail = async (response: Response) => {
          try {
            const data = await response.json();
            const error = typeof data?.error === "string" ? data.error : "";
            const detail = typeof data?.detail === "string" ? data.detail : "";
            return [error, detail].filter(Boolean).join(" - ");
          } catch {
            return "";
          }
        };

        const payload = {
          referenceText: referenceSnapshot,
          asrText: transcriptSnapshot,
          confidenceScores: confidenceSnapshot,
          accuracy: score,
          ...(wavBase64 ? { wavBase64 } : {}),
        };
        let response: Response;
        if (wavBase64) {
          response = await fetch(`${BACKEND_URL}/api/evaluate-pronunciation-azure`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          usedAzureScore = response.ok;
          if (!response.ok) {
            // Fallback: keep user flow working even if Azure metrics are incomplete.
            const azureDetail = await parseErrorDetail(response);
            response = await fetch(`${BACKEND_URL}/api/evaluate-pronunciation`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                referenceText: referenceSnapshot,
                asrText: transcriptSnapshot,
                confidenceScores: confidenceSnapshot,
                accuracy: score,
              }),
            });
            if (!response.ok) {
              const groqDetail = await parseErrorDetail(response);
              throw new Error(
                `Azure failed (${azureDetail || "no detail"}) and Groq fallback failed (${groqDetail || `HTTP ${response.status}`})`
              );
            }
            usedAzureScore = false;
          }
        } else {
          response = await fetch(`${BACKEND_URL}/api/evaluate-pronunciation`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            const detail = await parseErrorDetail(response);
            throw new Error(detail || `HTTP ${response.status}`);
          }
          usedAzureScore = false;
        }

        const data = await response.json();
        const scoreSource = typeof data?.source === "string" ? data.source : "";
        const isStrictAzureScore = scoreSource === "azure" || scoreSource === "azure_partial";
        usedAzureScore = usedAzureScore && isStrictAzureScore;
        const feedback = typeof data?.feedback === "string" ? data.feedback.trim() : "";
        const overallScore = Number.isFinite(Number(data?.overallScore)) ? Number(data.overallScore) : null;
        const criticalPoints = Array.isArray(data?.criticalPoints)
          ? data.criticalPoints.map((x: unknown) => String(x).trim()).filter(Boolean)
          : [];
        const actionDrill = typeof data?.actionDrill === "string" ? data.actionDrill.trim() : "";
        const weakWords = Array.isArray(data?.weakWords)
          ? data.weakWords.map((x: unknown) => String(x).trim()).filter(Boolean)
          : [];
        const weakWordDetails = Array.isArray(data?.weakWordDetails)
          ? data.weakWordDetails
              .map((x: unknown) => {
                const row = x as Record<string, unknown>;
                return {
                  word: String(row?.word || "").trim(),
                  accuracy: Number(row?.accuracy),
                  errorType:
                    row?.errorType === null || row?.errorType === undefined
                      ? null
                      : String(row.errorType),
                };
              })
              .filter((x) => x.word && Number.isFinite(x.accuracy))
          : [];
        const wordScores = Array.isArray(data?.wordScores)
          ? data.wordScores
              .map((x: unknown) => {
                const row = x as Record<string, unknown>;
                return {
                  word: String(row?.word || "").trim(),
                  accuracy: Number(row?.accuracy),
                  errorType:
                    row?.errorType === null || row?.errorType === undefined
                      ? null
                      : String(row.errorType),
                };
              })
              .filter((x) => x.word && Number.isFinite(x.accuracy))
          : [];
        const axes = data?.axes || null;

        if (axes && typeof axes === "object" && usedAzureScore) {
          const mapped: PronunciationSignature = {
            overall: Math.max(0, Math.min(1, (overallScore ?? score ?? 70) / 100)),
            axes: [
              { label: "Clarity", value: normalize01((axes as Record<string, unknown>).clarity) },
              { label: "Stress/Intonation", value: normalize01((axes as Record<string, unknown>).stress_intonation) },
              { label: "Consonants", value: normalize01((axes as Record<string, unknown>).consonant_precision) },
              { label: "Vowels", value: normalize01((axes as Record<string, unknown>).vowel_quality) },
              { label: "Fluency", value: normalize01((axes as Record<string, unknown>).fluency) },
            ],
          };
          setModelSignature(mapped);
        }

        const mergedWordDiagnostics =
          weakWordDetails.length > 0
            ? weakWordDetails
            : wordScores
                .filter((x) => x.accuracy < 75 || !!x.errorType)
                .sort((a, b) => a.accuracy - b.accuracy)
                .slice(0, 12);
        setWordDiagnostics(mergedWordDiagnostics);

        const conciseHint = [
          ...criticalPoints.slice(0, 2).map((p) => `- ${p}`),
          actionDrill ? `- Action: ${actionDrill}` : "",
          weakWords.length ? `- Weak words: ${weakWords.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        setFinishSummary((prev) => ({
          score: usedAzureScore ? (overallScore ?? prev.score) : prev.score,
          hint: conciseHint || feedback || fallbackHint,
        }));
      } catch (err) {
        console.error("[Pronunciation] evaluation failed", err);
        setWordDiagnostics([]);
        setModelSignature(null);
        setFinishSummary((prev) => ({
          ...prev,
          hint: fallbackHint,
        }));
        toast({
          title: "Evaluation failed",
          description: err instanceof Error ? err.message : "Could not evaluate pronunciation. Showing fallback advice.",
          variant: "destructive",
        });
      } finally {
        setIsEvaluatingPronunciation(false);
      }
    })();
  }, [
    analysis.accuracy,
    getRecordedWavBase64,
    hasFinalSpeech,
    hint,
    mediaStream,
    referenceText,
    stopASR,
    toast,
    transcript,
    wordConfidences,
  ]);

  const handleGenerateReferenceText = useCallback(async () => {
    if (isGeneratingReference) return;
    setIsGeneratingReference(true);

    try {
      resetSession();
      const response = await fetch(`${BACKEND_URL}/api/generate-reference-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lengthWords: 24,
          level: "b1",
          includeCommonPronunciationPairs: true,
        }),
      });
      if (!response.ok) {
        let detail = "";
        try {
          const errJson = await response.json();
          detail = typeof errJson?.detail === "string"
            ? errJson.detail
            : typeof errJson?.error === "string"
              ? errJson.error
              : "";
        } catch {
          detail = "";
        }
        throw new Error(`HTTP ${response.status}${detail ? ` - ${detail}` : ""}`);
      }

      const data = await response.json();
      const nextText = typeof data?.text === "string" ? data.text.trim() : "";
      if (!nextText) throw new Error("No text returned from generator");

      setReferenceText(nextText);
      toast({
        title: "Reference text updated",
        description: "A new practice sentence is ready.",
      });
    } catch (err) {
      console.error("[ReferenceText] generation failed", err);
      toast({
        title: "Generation failed",
        description: `Using default sentence. Check backend at ${BACKEND_URL}.`,
        variant: "destructive",
      });
      setReferenceText(sampleText.trim());
    } finally {
      setIsGeneratingReference(false);
    }
  }, [isGeneratingReference, resetSession, toast]);

  const toggleRecording = useCallback(async () => {
    if (!isRecording) {
      // Start recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        recorder.start();
        setMediaStream(stream);
        setIsRecording(true);
        setIsPaused(false);
        await startASR(stream);
      } catch (err) {
        console.error("Mic access denied:", err);
      }
      return;
    }

    // Toggle pause/resume when already recording
    if (!mediaStream) return;
    if (isPaused) {
      resumeASR();
    } else {
      pauseASR();
    }
    setIsPaused(!isPaused);
  }, [isRecording, isPaused, mediaStream, startASR, pauseASR, resumeASR]);

  const stopEvaluationAudio = useCallback(() => {
    playbackSessionRef.current += 1;
    for (const controller of ttsAbortControllersRef.current) {
      controller.abort();
    }
    ttsAbortControllersRef.current = [];

    if (evaluationAudioRef.current) {
      evaluationAudioRef.current.pause();
      evaluationAudioRef.current.currentTime = 0;
      evaluationAudioRef.current = null;
    }
    if (evaluationAudioPrimaryUrlRef.current) {
      URL.revokeObjectURL(evaluationAudioPrimaryUrlRef.current);
      evaluationAudioPrimaryUrlRef.current = null;
    }
    if (evaluationAudioSecondaryUrlRef.current) {
      URL.revokeObjectURL(evaluationAudioSecondaryUrlRef.current);
      evaluationAudioSecondaryUrlRef.current = null;
    }
    setIsReadingEvaluation(false);
  }, []);

  const speakEvaluation = useCallback(() => {
    if (isReadingEvaluation) {
      stopEvaluationAudio();
      return;
    }

    const feedbackText = isEvaluatingPronunciation
      ? "Overall assessment: Evaluation is still in progress. Please wait a moment."
      : finishSummary.hint || "Overall assessment: No advice available yet.";

    const splitFeedback = (raw: string) => {
      const text = raw.replace(/\r/g, "").trim();
      if (!text) return { overall: "", rest: "" };

      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      const overallLineIndex = lines.findIndex((line) =>
        /^(\d+[\)\.\-:]?\s*)?overall assessment\b/i.test(line)
      );

      if (overallLineIndex >= 0) {
        const overallLine = lines[overallLineIndex].replace(
          /^(\d+[\)\.\-:]?\s*)?overall assessment[:\s-]*/i,
          ""
        ).trim();
        const overall = overallLine || lines[overallLineIndex];
        const rest = lines
          .filter((_, idx) => idx !== overallLineIndex)
          .join("\n")
          .trim();
        return { overall, rest };
      }

      const [first, ...others] = lines;
      return { overall: first || text, rest: others.join("\n").trim() };
    };

    const requestSpeechUrl = async (text: string) => {
      const controller = new AbortController();
      ttsAbortControllersRef.current.push(controller);
      try {
        const response = await fetch(`${BACKEND_URL}/api/speak-feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      } finally {
        ttsAbortControllersRef.current = ttsAbortControllersRef.current.filter((c) => c !== controller);
      }
    };

    void (async () => {
      try {
        stopEvaluationAudio();
        const sessionId = ++playbackSessionRef.current;
        const { overall, rest } = splitFeedback(feedbackText);
        const firstChunk = overall || feedbackText;

        const firstUrl = await requestSpeechUrl(firstChunk);
        if (sessionId !== playbackSessionRef.current) {
          URL.revokeObjectURL(firstUrl);
          return;
        }
        evaluationAudioPrimaryUrlRef.current = firstUrl;
        const firstAudio = new Audio(firstUrl);
        evaluationAudioRef.current = firstAudio;

        const secondUrlPromise = rest ? requestSpeechUrl(rest) : Promise.resolve<string | null>(null);

        firstAudio.onpause = () => {
          if (sessionId === playbackSessionRef.current) setIsReadingEvaluation(false);
        };
        firstAudio.onerror = () => {
          if (sessionId === playbackSessionRef.current) setIsReadingEvaluation(false);
        };
        firstAudio.onended = async () => {
          try {
            const secondUrl = await secondUrlPromise;
            if (!secondUrl || sessionId !== playbackSessionRef.current) {
              setIsReadingEvaluation(false);
              return;
            }

            evaluationAudioSecondaryUrlRef.current = secondUrl;
            const secondAudio = new Audio(secondUrl);
            evaluationAudioRef.current = secondAudio;
            secondAudio.onended = () => setIsReadingEvaluation(false);
            secondAudio.onpause = () => setIsReadingEvaluation(false);
            secondAudio.onerror = () => setIsReadingEvaluation(false);
            await secondAudio.play();
          } catch {
            if (sessionId === playbackSessionRef.current) setIsReadingEvaluation(false);
          }
        };

        await firstAudio.play();
        setIsReadingEvaluation(true);
      } catch (err) {
        if (String(err).includes("AbortError")) return;
        setIsReadingEvaluation(false);
        console.error("[Speech] failed to play Smallest AI audio:", err);
        toast({
          title: "Speech playback failed",
          description:
            "Could not play Smallest AI audio. Check backend/.env SMALLEST_AI_API_KEY and SMALLEST_TTS_VOICE_ID.",
          variant: "destructive",
        });
      }
    })();
  }, [finishSummary.hint, isEvaluatingPronunciation, isReadingEvaluation, stopEvaluationAudio, toast]);

  useEffect(() => {
    const speakPrompt = () => {
      if (hasSpokenPromptRef.current) return;
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(
          "Hello. Please read the sentence above."
        );
        utterance.lang = "en-US";
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.volume = 1;
        utterance.onstart = () => {
          hasSpokenPromptRef.current = true;
        };
        utterance.onend = () => {
          hasSpokenPromptRef.current = true;
        };
        window.speechSynthesis.speak(utterance);
      } catch {
        // Ignore TTS runtime errors and keep the page functional.
      }
    };

    const timer = window.setTimeout(speakPrompt, 500);
    const retryOnFirstInteraction = () => speakPrompt();
    window.addEventListener("pointerdown", retryOnFirstInteraction, { once: true });

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", retryOnFirstInteraction);
      stopEvaluationAudio();
    };
  }, [stopEvaluationAudio]);

  return (
    <div
      className={`relative min-h-screen bg-background grid-bg flex flex-col theme-${theme}`}
      data-theme={theme}
    >
      {/* Header */}
      <header className="border-b border-border/50 px-6 py-4 themed-header">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-primary neon-glow" />
            <h1 className="themed-title font-display text-sm tracking-[0.3em] uppercase text-primary neon-text">
              VocalLens
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-display text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
              AI Oral Coach
            </span>
            <label className="sr-only" htmlFor="theme-select">
              Select theme
            </label>
            <select
              id="theme-select"
              value={theme}
              onChange={(e) => {
                const nextTheme = e.target.value as typeof theme;
                if (nextTheme !== theme) {
                  setTheme(nextTheme);
                  resetSession();
                }
              }}
              className="theme-select rounded-md border border-border/60 bg-card/70 px-3 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="minimal">Minimal</option>
              <option value="neon">Neon</option>
              <option value="trendy">Trendy</option>
              <option value="accessible">Accessible</option>
            </select>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="themed-main flex-1 flex flex-col items-center justify-center px-6 py-10 gap-8 max-w-3xl mx-auto w-full">
        <ReferenceText
          text={referenceText}
          onGenerate={handleGenerateReferenceText}
          isGenerating={isGeneratingReference}
        />
        <TranscriptionDisplay
          transcript={transcript}
          partialTranscript={partialTranscript}
          tokens={analysis.tokens}
          isConnected={isConnected}
          isRecording={isRecording}
        />
        <AnalysisDashboard
          accuracy={hasFinalSpeech ? analysis.accuracy : null}
          hint={hint}
          signature={modelSignature}
        />
        <Waveform
          theme={theme}
          isRecording={isRecording}
          isPaused={isPaused}
          mediaStream={mediaStream}
        />
        <div className="flex flex-col items-center gap-3">
          <RecordButton
            isRecording={isRecording}
            isPaused={isPaused}
            onToggle={toggleRecording}
          />
          <div className="flex gap-3">
            <button
              onClick={resetSession}
              className="themed-action-btn px-3 py-2 rounded-md border border-border bg-card/70 text-sm hover:border-primary"
            >
              Reset
            </button>
            <button
              onClick={finishSession}
              className="themed-action-btn px-3 py-2 rounded-md border border-border bg-card/70 text-sm hover:border-primary"
            >
              Finish
            </button>
          </div>
        </div>
      </main>

      <Dialog
        open={isFinishDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            stopEvaluationAudio();
          }
          setIsFinishDialogOpen(open);
        }}
      >
        <DialogContent
          className={`max-w-md themed-textbox themed-result-dialog border-border bg-card/95 theme-${theme}`}
        >
          <DialogHeader>
            <DialogTitle className="themed-kicker text-base tracking-[0.12em] uppercase">
              Final Result
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Session has ended. Here is your final score and coaching advice.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="themed-result-card rounded-md border border-border/60 bg-background/60 p-3">
              <p className="themed-kicker text-xs uppercase tracking-[0.16em] text-muted-foreground">
                Final Score
              </p>
              <p className="mt-1 text-3xl font-semibold text-primary">
                {finishSummary.score === null ? "--" : `${finishSummary.score.toFixed(1)}%`}
              </p>
            </div>
            <div
              className="themed-result-card rounded-md border border-border/60 bg-background/60 p-3 cursor-pointer"
              title={isReadingEvaluation ? "Left click again to stop reading" : "Left click to read advice"}
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                speakEvaluation();
              }}
            >
              <p className="themed-kicker text-xs uppercase tracking-[0.16em] text-muted-foreground">
                Advice
              </p>
              <div className="mt-1 max-h-56 overflow-y-auto pr-1 space-y-2 text-sm text-card-foreground">
                {adviceSections.map((section, index) => (
                  <p key={`${section.slice(0, 24)}-${index}`} className="leading-relaxed">
                    {section}
                  </p>
                ))}
                </div>
              </div>
            {wordDiagnostics.length > 0 && (
              <div className="themed-result-card rounded-md border border-border/60 bg-background/60 p-3">
                <p className="themed-kicker text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Word Accuracy (Azure)
                </p>
                <div className="mt-2 max-h-44 overflow-y-auto pr-1 space-y-1 text-sm">
                  {wordDiagnostics.map((item, index) => (
                    <div key={`${item.word}-${index}`} className="flex items-center justify-between gap-3">
                      <span className="text-card-foreground">
                        {item.word}
                        {item.errorType ? (
                          <span className="ml-2 text-[11px] text-destructive/90">({item.errorType})</span>
                        ) : null}
                      </span>
                      <span className={item.accuracy < 75 ? "text-destructive font-semibold" : "text-muted-foreground"}>
                        {Math.round(item.accuracy)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Decorative bottom line */}
      <motion.div
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 1, delay: 0.5 }}
        className="h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
      />
    </div>
  );
};

export default Index;

function normalize01(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}
