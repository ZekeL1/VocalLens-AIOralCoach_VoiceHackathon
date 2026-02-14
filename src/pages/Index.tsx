import { useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import ReferenceText from "@/components/ReferenceText";
import Waveform from "@/components/Waveform";
import RecordButton from "@/components/RecordButton";
import TranscriptionDisplay from "@/components/TranscriptionDisplay";
import { useASR } from "@/hooks/useASR";

const Index = () => {
  const [isRecording, setIsRecording] = useState(false);
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

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      // Stop
      stopASR();
      mediaRecorderRef.current?.stop();
      mediaStream?.getTracks().forEach((t) => t.stop());
      setMediaStream(null);
      setIsRecording(false);
    } else {
      // Start
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
        // Start ASR
        await startASR(stream);
      } catch (err) {
        console.error("Mic access denied:", err);
      }
    }
  }, [isRecording, mediaStream, startASR, stopASR]);

  return (
    <div className="relative min-h-screen bg-background grid-bg flex flex-col">
      {/* Header */}
      <header className="border-b border-border/50 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-primary neon-glow" />
            <h1 className="font-display text-sm tracking-[0.3em] uppercase text-primary neon-text">
              ECE Speak
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
          isConnected={isConnected}
          isRecording={isRecording}
        />
        <Waveform isRecording={isRecording} mediaStream={mediaStream} />
        <RecordButton isRecording={isRecording} onToggle={toggleRecording} />
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
