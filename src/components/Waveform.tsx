import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import WaveSurfer from "wavesurfer.js";
// Record plugin ships within wavesurfer package
import RecordPlugin from "wavesurfer.js/dist/plugins/record.esm.js";

interface WaveformProps {
  isRecording: boolean;
  mediaStream: MediaStream | null;
}

const Waveform = ({ isRecording, mediaStream }: WaveformProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<WaveSurfer | null>(null);
  const recordRef = useRef<any>(null);

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
        waveColor: "rgba(63,255,167,0.35)",
        progressColor: "rgba(63,255,167,0.9)",
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
  }, [isRecording, mediaStream]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className="w-full"
    >
      <div className="relative rounded-lg border border-border bg-card/50 p-4 overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-30" />
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
