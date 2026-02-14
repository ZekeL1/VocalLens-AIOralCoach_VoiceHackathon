import { useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ASRResult {
  transcript: string;
  is_final: boolean;
  is_last?: boolean;
  session_id?: string;
}

export interface UseASRReturn {
  transcript: string;
  partialTranscript: string;
  isConnected: boolean;
  audioBuffers: Float32Array[];
  audioDuration: number;
  startASR: (stream: MediaStream) => Promise<void>;
  stopASR: () => void;
  resetTranscript: () => void;
}

const SAMPLE_RATE = 16000;
const WS_URL =
  import.meta.env.DEV
    ? `ws://${location.host}/asr-ws/api/v1/lightning/get_text`
    : "wss://waves-api.smallest.ai/api/v1/lightning/get_text";
const MAX_SAMPLES = SAMPLE_RATE * 120;

export function useASR(): UseASRReturn {
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioBuffersRef = useRef<Float32Array[]>([]);
  const [audioBuffers, setAudioBuffers] = useState<Float32Array[]>([]);
  const [audioDuration, setAudioDuration] = useState(0);

  const fetchToken = useCallback(async (): Promise<string> => {
    const { data, error } = await supabase.functions.invoke("get-asr-token");
    if (error) throw new Error("Failed to fetch ASR token");
    return data.token;
  }, []);

  const startASR = useCallback(
    async (stream: MediaStream) => {
      audioBuffersRef.current = [];
      setAudioBuffers([]);
      setAudioDuration(0);
      setPartialTranscript("");
      setTranscript("");

      const token = await fetchToken();

      const url = new URL(WS_URL);
      url.searchParams.set("authorization", `Bearer ${token}`);
      url.searchParams.set("language", "en");
      url.searchParams.set("encoding", "linear16");
      url.searchParams.set("sample_rate", String(SAMPLE_RATE));
      url.searchParams.set("word_timestamps", "false");
      url.searchParams.set("full_transcript", "true");

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);

      ws.onmessage = (event) => {
        try {
          const result: ASRResult = JSON.parse(event.data);
          if (result.is_final) {
            const finalText = (result.transcript || "").trim();
            if (!finalText) {
              setPartialTranscript("");
              return;
            }
            setTranscript((prev) => {
              if (finalText.startsWith(prev)) return finalText;
              if (prev.startsWith(finalText)) return prev;
              return prev ? `${prev} ${finalText}` : finalText;
            });
            setPartialTranscript("");
          } else {
            setPartialTranscript(result.transcript || "");
          }
        } catch (e) {
          console.warn("[ASR] Failed to parse message:", e);
        }
      };

      ws.onerror = (e) => console.error("[ASR] WebSocket error:", e);
      ws.onclose = () => setIsConnected(false);

      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        pushWithCap(audioBuffersRef.current, copy, MAX_SAMPLES);
        const pcm16 = float32ToInt16(input);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(pcm16 as unknown as ArrayBuffer);
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
    },
    [fetchToken]
  );

  const stopASR = useCallback(() => {
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ eof: true }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    const buffers = audioBuffersRef.current;
    setAudioBuffers([...buffers]);
    const totalSamples = buffers.reduce((s, b) => s + b.length, 0);
    setAudioDuration(totalSamples / SAMPLE_RATE);

    setIsConnected(false);
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    setPartialTranscript("");
  }, []);

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

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function pushWithCap(target: Float32Array[], chunk: Float32Array, maxSamples: number) {
  target.push(chunk);
  let total = target.reduce((s, b) => s + b.length, 0);
  while (total > maxSamples && target.length > 1) {
    const removed = target.shift();
    total -= removed?.length || 0;
  }
}
