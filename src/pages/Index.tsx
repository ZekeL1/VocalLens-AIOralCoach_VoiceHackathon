import { useState, useCallback, useRef, useEffect } from "react";
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

const Index = () => {
  const [theme, setTheme] = useState<
    "neon" | "minimal" | "trendy" | "accessible"
  >("minimal");
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFinishDialogOpen, setIsFinishDialogOpen] = useState(false);
  const [finishSummary, setFinishSummary] = useState<{
    score: number | null;
    hint: string | null;
  }>({ score: null, hint: null });
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
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
    setIsFinishDialogOpen(false);
    resetTranscript();
  }, [mediaStream, stopASR, resetTranscript]);

  const finishSession = useCallback(() => {
    setFinishSummary({
      score: hasFinalSpeech ? analysis.accuracy : null,
      hint,
    });
    stopASR();
    mediaRecorderRef.current?.stop();
    mediaStream?.getTracks().forEach((t) => t.stop());
    setMediaStream(null);
    setIsRecording(false);
    setIsPaused(false);
    setIsFinishDialogOpen(true);
  }, [analysis.accuracy, hasFinalSpeech, hint, mediaStream, stopASR]);

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
        onOpenChange={setIsFinishDialogOpen}
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
            <div className="themed-result-card rounded-md border border-border/60 bg-background/60 p-3">
              <p className="themed-kicker text-xs uppercase tracking-[0.16em] text-muted-foreground">
                Advice
              </p>
              <p className="mt-1 text-sm text-card-foreground">
                {finishSummary.hint || "No advice available yet. Try another recording."}
              </p>
            </div>
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
