import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

interface WaveformProps {
  isRecording: boolean;
  mediaStream: MediaStream | null;
}

const Waveform = ({ isRecording, mediaStream }: WaveformProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (isRecording && mediaStream && canvasRef.current) {
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      const source = audioCtx.createMediaStreamSource(mediaStream);
      source.connect(analyser);
      analyserRef.current = analyser;
      audioCtxRef.current = audioCtx;

      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d")!;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
        animationRef.current = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const WIDTH = rect.width;
        const HEIGHT = rect.height;

        ctx.clearRect(0, 0, WIDTH, HEIGHT);

        const barWidth = (WIDTH / bufferLength) * 1.5;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 255;
          const barHeight = v * HEIGHT * 0.8;

          const gradient = ctx.createLinearGradient(0, HEIGHT, 0, HEIGHT - barHeight);
          gradient.addColorStop(0, `hsla(145, 100%, 50%, 0.1)`);
          gradient.addColorStop(0.5, `hsla(145, 100%, 50%, 0.6)`);
          gradient.addColorStop(1, `hsla(145, 100%, 50%, 1)`);

          ctx.fillStyle = gradient;

          const y = (HEIGHT - barHeight) / 2;
          ctx.beginPath();
          ctx.roundRect(x, y, barWidth - 1, barHeight, 2);
          ctx.fill();

          // Glow effect
          ctx.shadowColor = "hsl(145, 100%, 50%)";
          ctx.shadowBlur = 8 * v;
          ctx.fill();
          ctx.shadowBlur = 0;

          x += barWidth + 1;
        }
      };

      draw();
    } else {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (audioCtxRef.current) audioCtxRef.current.close();

      // Draw idle state
      if (canvasRef.current) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d")!;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const WIDTH = rect.width;
        const HEIGHT = rect.height;
        ctx.clearRect(0, 0, WIDTH, HEIGHT);

        // Draw flat idle bars
        const barCount = 64;
        const barWidth = (WIDTH / barCount) * 1.2;
        let x = 0;
        for (let i = 0; i < barCount; i++) {
          const barHeight = 2;
          ctx.fillStyle = "hsla(145, 100%, 50%, 0.15)";
          ctx.beginPath();
          ctx.roundRect(x, (HEIGHT - barHeight) / 2, barWidth - 1, barHeight, 1);
          ctx.fill();
          x += barWidth + 1;
        }
      }
    }

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
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
        <canvas
          ref={canvasRef}
          className="relative z-10 w-full h-32 md:h-40"
        />
        <div className="relative z-10 flex items-center justify-between mt-2">
          <span className="font-display text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
            {isRecording ? "● Live Audio" : "Standby"}
          </span>
          <span className="font-display text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
            ECE Audio Engine
          </span>
        </div>
      </div>
    </motion.div>
  );
};

export default Waveform;
