import { useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import ReferenceText from "@/components/ReferenceText";
import Waveform from "@/components/Waveform";
import RecordButton from "@/components/RecordButton";
import TranscriptionDisplay from "@/components/TranscriptionDisplay";
import { useASR } from "@/hooks/useASR";
import AnalysisDashboard from "@/components/AnalysisDashboard";
import { diffWords, pickPhonemeHint } from "@/lib/scoring";
import { sampleText } from "@/components/ReferenceText";

const Index = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const {
    transcript,
    partialTranscript,
    isConnected,
    audioBuffers,
    audioDuration,
    startASR,
    stopASR,
    resetTranscript,
  } = useASR();

  const hasSpeech = transcript.trim().length > 0 || partialTranscript.trim().length > 0;
  const analysis = hasSpeech
    ? diffWords(sampleText, transcript)
    : { tokens: [], accuracy: 0, mismatches: [] };
  const hint = hasSpeech ? pickPhonemeHint(analysis.mismatches) : null;

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
    const next = !isPaused;
    mediaStream.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setIsPaused(!isPaused);
  }, [isRecording, isPaused, mediaStream, startASR]);

  return (
    <div className="relative min-h-screen bg-background grid-bg flex flex-col">
      {/* Header */}
      <header className="border-b border-border/50 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-primary neon-glow" />
            <h1 className="font-display text-sm tracking-[0.3em] uppercase text-primary neon-text">
              VocalLens
            </h1>
          </div>
          <span className="font-display text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
            AI Oral Coach
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-10 gap-8 max-w-3xl mx-auto w-full">
        <ReferenceText />
        <TranscriptionDisplay
          transcript={transcript}
          partialTranscript={partialTranscript}
          tokens={analysis.tokens}
          isConnected={isConnected}
          isRecording={isRecording}
        />
        <AnalysisDashboard accuracy={hasSpeech ? analysis.accuracy : null} hint={hint} />
        <Waveform isRecording={isRecording} mediaStream={mediaStream} />
        <div className="flex flex-col items-center gap-3">
          <RecordButton
            isRecording={isRecording}
            isPaused={isPaused}
            onToggle={toggleRecording}
          />
          <div className="flex gap-3">
            <button
              onClick={() => {
                stopASR();
                mediaRecorderRef.current?.stop();
                mediaStream?.getTracks().forEach((t) => t.stop());
                setMediaStream(null);
                setIsRecording(false);
                setIsPaused(false);
                resetTranscript();
              }}
              className="px-3 py-2 rounded-md border border-border bg-card/70 text-sm hover:border-primary"
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
              }}
              className="px-3 py-2 rounded-md border border-border bg-card/70 text-sm hover:border-primary"
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
