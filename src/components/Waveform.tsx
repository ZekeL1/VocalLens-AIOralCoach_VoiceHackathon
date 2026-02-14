import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import WaveSurfer from "wavesurfer.js";
// Record plugin ships within wavesurfer package
import RecordPlugin from "wavesurfer.js/dist/plugins/record.esm.js";

interface WaveformProps {
  theme: "neon" | "minimal" | "trendy" | "accessible";
  isRecording: boolean;
  isPaused: boolean;
  mediaStream: MediaStream | null;
}

const THEME_WAVE_STYLES: Record<
  WaveformProps["theme"],
  { waveColor: string; progressColor: string }
> = {
  neon: {
    waveColor: "rgba(63,255,167,0.35)",
    progressColor: "rgba(63,255,167,0.92)",
  },
  minimal: {
    waveColor: "rgba(58,110,214,0.32)",
    progressColor: "rgba(58,110,214,0.88)",
  },
  trendy: {
    waveColor: "rgba(255,77,183,0.38)",
    progressColor: "rgba(255,156,51,0.95)",
  },
  accessible: {
    waveColor: "rgba(0,0,0,0.42)",
    progressColor: "rgba(0,50,153,1)",
  },
};

const Waveform = ({ theme, isRecording, isPaused, mediaStream }: WaveformProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<WaveSurfer | null>(null);
  const recordRef = useRef<any>(null);
  const waveStyle = THEME_WAVE_STYLES[theme];

  useEffect(() => {
    if (isRecording && mediaStream && containerRef.current) {
      const record = RecordPlugin.create({
        renderRecordedAudio: false,
        continuousWaveform: true,
        scrollingWaveform: true,
        mediaRecorderTimeslice: 250,
      });

      const ws = WaveSurfer.create({
        container: containerRef.current,
        height: 140,
        waveColor: waveStyle.waveColor,
        progressColor: waveStyle.progressColor,
        cursorWidth: 0,
        interact: false,
        normalize: true,
        plugins: [record],
      });

      waveRef.current = ws;
      recordRef.current = record;

      // Reuse existing MediaStream: feed to record plugin for visualization
      record.stream = mediaStream;
      record.renderMicStream(mediaStream);
      record.startRecording();
    } else {
      recordRef.current?.stopRecording();
      recordRef.current?.destroy?.();
      waveRef.current?.destroy();
      recordRef.current = null;
      waveRef.current = null;
    }

    return () => {
      recordRef.current?.stopRecording();
      recordRef.current?.destroy?.();
      waveRef.current?.destroy();
      recordRef.current = null;
      waveRef.current = null;
    };
  }, [isRecording, mediaStream, waveStyle.progressColor, waveStyle.waveColor]);

  useEffect(() => {
    if (recordRef.current && recordRef.current.wavesurfer) {
      if (isPaused) {
        recordRef.current.pauseRecording?.();
        recordRef.current.wavesurfer.setMuted(true);
      } else {
        recordRef.current.resumeRecording?.();
        recordRef.current.wavesurfer.setMuted(false);
      }
    }
  }, [isPaused]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className="w-full"
    >
      <div className="themed-wave-card relative rounded-lg border border-border bg-card/50 p-4 overflow-hidden">
        <div className="themed-wave-grid absolute inset-0 grid-bg opacity-30" />
        <div ref={containerRef} className="relative z-10 w-full h-32 md:h-36" />
        <div className="relative z-10 flex items-center justify-between mt-2">
          <span className="font-display text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
            {isRecording ? "● Live Audio" : "Standby"}
          </span>
          <span className="font-display text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
            VocalLens Engine
          </span>
        </div>
      </div>
    </motion.div>
  );
};

export default Waveform;
