import { useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ASRResult {
  transcript: string;
  is_final: boolean;
  is_last: boolean;
  session_id: string;
}

export interface UseASRReturn {
  /** Full accumulated transcript */
  transcript: string;
  /** Current partial (non-final) segment */
  partialTranscript: string;
  /** Whether WebSocket is connected */
  isConnected: boolean;
  /** Raw PCM audio buffers collected during recording */
  audioBuffers: Float32Array[];
  /** Total duration in seconds of collected audio */
  audioDuration: number;
  /** Start ASR session – call after mic stream is obtained */
  startASR: (stream: MediaStream) => Promise<void>;
  /** Stop ASR session */
  stopASR: () => void;
  /** Reset transcript */
  resetTranscript: () => void;
}

const SAMPLE_RATE = 16000;
const WS_URL =
  import.meta.env.DEV
    ? `ws://${location.host}/asr-ws/api/v1/lightning/get_text`
    : "wss://waves-api.smallest.ai/api/v1/lightning/get_text";

export function useASR(): UseASRReturn {
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  const transcriptRef = useRef<string>("");
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioBuffersRef = useRef<Float32Array[]>([]);
  const [audioBuffers, setAudioBuffers] = useState<Float32Array[]>([]);
  const [audioDuration, setAudioDuration] = useState(0);
  const lastFinalRef = useRef<string>("");

  const fetchToken = useCallback(async (): Promise<string> => {
    const { data, error } = await supabase.functions.invoke("get-asr-token");
    if (error) throw new Error("Failed to fetch ASR token");
    return data.token;
  }, []);

  const startASR = useCallback(async (stream: MediaStream) => {
    // Reset
    audioBuffersRef.current = [];
    lastFinalRef.current = "";
    setTranscript("");
    transcriptRef.current = "";
    setAudioBuffers([]);
    setAudioDuration(0);
    setPartialTranscript("");

    const token = await fetchToken();

    // Build WebSocket URL with params
    const url = new URL(WS_URL);
    // 在 query 携带 token，避免代理头缺失导致 401
    url.searchParams.set("authorization", `Bearer ${token}`);
    url.searchParams.set("language", "en");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(SAMPLE_RATE));
    url.searchParams.set("word_timestamps", "false");
    url.searchParams.set("full_transcript", "true"); // API will send cumulative transcript

    const ws = new WebSocket(url.toString());
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[ASR] WebSocket connected");
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const result: ASRResult = JSON.parse(event.data);
        if (result.is_final) {
          const finalText = (result.transcript || "").trim();
          if (!finalText) {
            setPartialTranscript("");
            return;
          }

          const prev = transcriptRef.current;

          if (finalText.startsWith(prev)) {
            setTranscript(finalText);
            transcriptRef.current = finalText;
            lastFinalRef.current = finalText;
          } else if (prev.startsWith(finalText)) {
            // ignore shorter snapshot
          } else {
            const combined = prev ? `${prev} ${finalText}` : finalText;
            setTranscript(combined);
            transcriptRef.current = combined;
            lastFinalRef.current = combined;
          }
          setPartialTranscript("");
        } else {
          setPartialTranscript(result.transcript || "");
        }
      } catch (e) {
        console.warn("[ASR] Failed to parse message:", e);
      }
    };

    ws.onerror = (e) => {
      console.error("[ASR] WebSocket error:", e);
    };

    ws.onclose = (e) => {
      console.log("[ASR] WebSocket closed:", e.code, e.reason);
      setIsConnected(false);
    };

    // Set up AudioContext for PCM capture
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtxRef.current = audioCtx;

    // Use ScriptProcessorNode for PCM capture (AudioWorklet would be better but requires extra file)
    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const bufferSize = 4096;
    const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      // Keep raw Float32 buffer for phoneme analysis
      const bufferCopy = new Float32Array(inputData.length);
      bufferCopy.set(inputData);
      audioBuffersRef.current.push(bufferCopy);

      // Convert to 16-bit PCM for sending to ASR
      const pcm16 = float32ToInt16(inputData);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(pcm16);
      }
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

    // Store processor ref for cleanup
    (audioCtxRef.current as any)._processor = processor;
  }, [fetchToken]);

  const stopASR = useCallback(() => {
    // Close WebSocket
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        // Send end-of-stream signal
        wsRef.current.send(JSON.stringify({ eof: true }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clean up audio
    if (audioCtxRef.current) {
      const processor = (audioCtxRef.current as any)._processor;
      if (processor) {
        processor.disconnect();
      }
      if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    // Snapshot buffers
    const buffers = audioBuffersRef.current;
    setAudioBuffers([...buffers]);
    const totalSamples = buffers.reduce((sum, b) => sum + b.length, 0);
    setAudioDuration(totalSamples / SAMPLE_RATE);

    setIsConnected(false);
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    setPartialTranscript("");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  return {
    transcript,
    partialTranscript,
    isConnected,
    audioBuffers,
    audioDuration,
    startASR,
    stopASR,
    resetTranscript,
  };
}

/** Convert Float32 [-1, 1] to Int16 PCM */
function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}
