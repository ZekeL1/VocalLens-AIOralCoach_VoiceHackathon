import { useState, useCallback, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import ReferenceText from "@/components/ReferenceText";
import Waveform from "@/components/Waveform";
import RecordButton from "@/components/RecordButton";
import TranscriptionDisplay from "@/components/TranscriptionDisplay";
import { useASR } from "@/hooks/useASR";
import AnalysisDashboard from "@/components/AnalysisDashboard";
import { diffWords, pickPhonemeHint } from "@/lib/scoring";
import { sampleText } from "@/components/ReferenceText";
import {
  cachePronunciationFeedback,
  requestPronunciationFeedback,
  type PronunciationFeedback,
} from "@/lib/pronunciationFeedback";

const Index = () => {
  const [theme, setTheme] = useState<
    "neon" | "minimal" | "trendy" | "accessible"
  >("minimal");
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [pendingFeedbackFetch, setPendingFeedbackFetch] = useState(false);
  const [cachedFeedback, setCachedFeedback] = useState<PronunciationFeedback | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const hasSpokenPromptRef = useRef(false);

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
  } = useASR();

  const hasFinalSpeech = transcript.trim().length > 0;
  const analysis = hasFinalSpeech
    ? diffWords(sampleText, transcript, wordConfidences)
    : { tokens: [], accuracy: 0, mismatches: [] };
  const hint = hasFinalSpeech ? pickPhonemeHint(analysis.mismatches) : null;

  const resetSession = useCallback(() => {
    stopASR();
    mediaRecorderRef.current?.stop();
    mediaStream?.getTracks().forEach((t) => t.stop());
    setMediaStream(null);
    setIsRecording(false);
    setIsPaused(false);
    setPendingFeedbackFetch(false);
    resetTranscript();
  }, [mediaStream, stopASR, resetTranscript]);

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

  useEffect(() => {
    if (!pendingFeedbackFetch) return;
    if (isConnected) return;
    if (isRecording) return;

    const finalTranscript = transcript.trim();
    if (!finalTranscript) {
      setPendingFeedbackFetch(false);
      return;
    }

    const payload = {
      sampleText,
      transcript: finalTranscript,
      wordConfidences,
      accuracy: hasFinalSpeech ? analysis.accuracy : null,
      mismatches: analysis.mismatches,
    };

    let cancelled = false;
    (async () => {
      try {
        const feedback = await requestPronunciationFeedback(payload);
        if (cancelled) return;
        setCachedFeedback(feedback);
        cachePronunciationFeedback(payload, feedback);
      } catch (err) {
        console.error("Failed to fetch pronunciation feedback:", err);
      } finally {
        if (!cancelled) setPendingFeedbackFetch(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    analysis.accuracy,
    analysis.mismatches,
    hasFinalSpeech,
    isConnected,
    isRecording,
    pendingFeedbackFetch,
    transcript,
    wordConfidences,
  ]);

  useEffect(() => {
    (window as Window & { __cachedPronunciationFeedback?: PronunciationFeedback | null }).__cachedPronunciationFeedback =
      cachedFeedback;
  }, [cachedFeedback]);

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
    };
  }, []);

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
        <ReferenceText />
        <TranscriptionDisplay
          transcript={transcript}
          partialTranscript={partialTranscript}
          tokens={analysis.tokens}
          isConnected={isConnected}
          isRecording={isRecording}
        />
        <AnalysisDashboard accuracy={hasFinalSpeech ? analysis.accuracy : null} hint={hint} />
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
              onClick={() => {
                // Placeholder for future history integration
                stopASR();
                mediaRecorderRef.current?.stop();
                mediaStream?.getTracks().forEach((t) => t.stop());
                setMediaStream(null);
                setIsRecording(false);
                setIsPaused(false);
                setPendingFeedbackFetch(true);
              }}
              className="themed-action-btn px-3 py-2 rounded-md border border-border bg-card/70 text-sm hover:border-primary"
            >
              Finish
            </button>
          </div>
        </div>
      </main>

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
