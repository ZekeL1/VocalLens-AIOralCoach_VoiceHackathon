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
  pauseASR: () => void;
  resumeASR: () => void;
  stopASR: () => void;
  resetTranscript: () => void;
}

const SAMPLE_RATE = 16000;
const WS_URL =
  import.meta.env.DEV
    ? `ws://${location.host}/asr-ws/api/v1/lightning/get_text`
    : "wss://waves-api.smallest.ai/api/v1/lightning/get_text";

// Keep last ~120s of audio buffers in memory
const MAX_SAMPLES = SAMPLE_RATE * 120;

// Endpointing params (tune if needed)
const RMS_SILENCE = 0.004;        // silence threshold
const SILENCE_FRAMES_TO_EOF = 12; // ~12 * (bufferSize/sampleRate) seconds
const SILENCE_FRAMES_CLEAR_PARTIAL = 8;

export function useASR(): UseASRReturn {
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  const audioBuffersRef = useRef<Float32Array[]>([]);
  const transcriptRef = useRef("");

  const [audioBuffers, setAudioBuffers] = useState<Float32Array[]>([]);
  const [audioDuration, setAudioDuration] = useState(0);

  // Controls
  const pausedRef = useRef(false);

  // Anti-repeat / dedupe
  const lastFinalRef = useRef("");
  const lastPartialRef = useRef("");
  const recentFinalsRef = useRef<string[]>([]);

  // Endpointing (VERY IMPORTANT FIX)
  const silenceFramesRef = useRef(0);
  const inUtteranceRef = useRef(false);
  const eofSentRef = useRef(false);

  const fetchToken = useCallback(async (): Promise<string> => {
    const { data, error } = await supabase.functions.invoke("get-asr-token");
    if (error) throw new Error("Failed to fetch ASR token");
    return data.token;
  }, []);

  const closeWs = useCallback((sendEof: boolean) => {
    const ws = wsRef.current;
    if (!ws) return;

    try {
      if (sendEof && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ eof: true }));
      }
    } catch {}

    try {
      ws.close();
    } catch {}

    wsRef.current = null;
    setIsConnected(false);
  }, []);

  const connectWs = useCallback(
    async (token: string) => {
      // Always close old ws before new one
      closeWs(false);

      const url = new URL(WS_URL);
      url.searchParams.set("authorization", `Bearer ${token}`);
      url.searchParams.set("language", "en");
      url.searchParams.set("encoding", "linear16");
      url.searchParams.set("sample_rate", String(SAMPLE_RATE));
      url.searchParams.set("word_timestamps", "false");
      url.searchParams.set("full_transcript", "false");

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);

      ws.onmessage = (event) => {
        try {
          if (pausedRef.current) return;

          const result: ASRResult = JSON.parse(event.data);

          if (result.is_final) {
            const finalText = (result.transcript || "").trim();

            if (!finalText) {
              setPartialTranscript("");
              return;
            }

            // Stronger: if we already "ended" utterance, ignore late finals
            if (eofSentRef.current) {
              setPartialTranscript("");
              return;
            }

            // Dedupe guards
            if (isSameNormalized(finalText, lastFinalRef.current)) {
              setPartialTranscript("");
              return;
            }
            if (isLoopingFinal(finalText, recentFinalsRef.current)) {
              setPartialTranscript("");
              return;
            }
            if (isLikelyRepeatedSegment(transcriptRef.current, finalText)) {
              setPartialTranscript("");
              return;
            }

            // Extra tail similarity guard (helps with "Yes." / punctuation variations)
            const tail = normalizeText(transcriptRef.current).slice(-400);
            if (tail && wordSimilarity(tail, normalizeText(finalText)) > 0.92) {
              setPartialTranscript("");
              return;
            }

            lastFinalRef.current = finalText;
            pushRecentFinal(recentFinalsRef.current, finalText);
            lastPartialRef.current = "";

            setTranscript((prev) => {
              const merged = mergeTranscript(prev, finalText);
              transcriptRef.current = merged;
              return merged;
            });

            setPartialTranscript("");
          } else {
            const partialText = (result.transcript || "").trim();
            if (!partialText) {
              lastPartialRef.current = "";
              setPartialTranscript("");
              return;
            }

            // If we already ended utterance, ignore partials too
            if (eofSentRef.current) return;

            if (isSameNormalized(partialText, lastPartialRef.current)) return;
            if (containsNormalized(transcriptRef.current, partialText)) return;

            lastPartialRef.current = partialText;
            setPartialTranscript(partialText);
          }
        } catch (e) {
          console.warn("[ASR] Failed to parse message:", e);
        }
      };

      ws.onerror = (e) => console.error("[ASR] WebSocket error:", e);

      ws.onclose = () => {
        setIsConnected(false);
        // If server closes after eof, get ready for next utterance
        // (We keep audio running; next voice will reconnect)
        if (wsRef.current === ws) wsRef.current = null;
      };
    },
    [closeWs]
  );

  const ensureWsOpen = useCallback(async () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (pausedRef.current) return;

    const token = await fetchToken();
    await connectWs(token);
  }, [connectWs, fetchToken]);

  const startASR = useCallback(
    async (stream: MediaStream) => {
      // Reset state
      audioBuffersRef.current = [];
      setAudioBuffers([]);
      setAudioDuration(0);

      setPartialTranscript("");
      setTranscript("");
      transcriptRef.current = "";

      lastFinalRef.current = "";
      lastPartialRef.current = "";
      recentFinalsRef.current = [];

      silenceFramesRef.current = 0;
      inUtteranceRef.current = false;
      eofSentRef.current = false;

      pausedRef.current = false;
      streamRef.current = stream;

      // Connect WS
      const token = await fetchToken();
      await connectWs(token);

      // Setup audio
      // Close any existing audio graph
      if (processorRef.current) {
        try { processorRef.current.disconnect(); } catch {}
        processorRef.current = null;
      }
      if (sourceRef.current) {
        try { sourceRef.current.disconnect(); } catch {}
        sourceRef.current = null;
      }
      if (gainRef.current) {
        try { gainRef.current.disconnect(); } catch {}
        gainRef.current = null;
      }
      if (audioCtxRef.current) {
        try { await audioCtxRef.current.close(); } catch {}
        audioCtxRef.current = null;
      }

      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // IMPORTANT: avoid direct processor -> destination (can cause weird behavior)
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;

      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = async (e) => {
        if (pausedRef.current) return;

        const input = e.inputBuffer.getChannelData(0);
        const rms = computeRms(input);

        // Silence path
        if (rms < RMS_SILENCE) {
          silenceFramesRef.current += 1;

          if (silenceFramesRef.current > SILENCE_FRAMES_CLEAR_PARTIAL) {
            setPartialTranscript("");
          }

          // Endpointing: treat long silence as end-of-utterance
          if (
            inUtteranceRef.current &&
            !eofSentRef.current &&
            silenceFramesRef.current > SILENCE_FRAMES_TO_EOF
          ) {
            eofSentRef.current = true;
            setPartialTranscript("");

            // Tell server this utterance is done, then CLOSE socket to avoid late-loop finals
            // Next voice will auto-reconnect via ensureWsOpen()
            closeWs(true);

            // Ready for next utterance
            inUtteranceRef.current = false;
          }

          return;
        }

        // Voice path
        silenceFramesRef.current = 0;

        // Start of a new utterance
        if (!inUtteranceRef.current) {
          inUtteranceRef.current = true;
          eofSentRef.current = false;
          // Reconnect if we closed after previous eof
          await ensureWsOpen();
        }

        // Keep audio buffers
        const copy = new Float32Array(input.length);
        copy.set(input);
        pushWithCap(audioBuffersRef.current, copy, MAX_SAMPLES);

        // Send to server
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const pcm16 = float32ToInt16(input);
          ws.send(pcm16 as unknown as ArrayBuffer);
        }
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(audioCtx.destination);
    },
    [connectWs, ensureWsOpen, fetchToken, closeWs]
  );

  const stopASR = useCallback(() => {
    pausedRef.current = false;

    // close ws (send eof to flush, then close)
    closeWs(true);

    // teardown audio
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch {}
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try { sourceRef.current.disconnect(); } catch {}
      sourceRef.current = null;
    }
    if (gainRef.current) {
      try { gainRef.current.disconnect(); } catch {}
      gainRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }

    // finalize buffers info
    const buffers = audioBuffersRef.current;
    setAudioBuffers([...buffers]);
    const totalSamples = buffers.reduce((s, b) => s + b.length, 0);
    setAudioDuration(totalSamples / SAMPLE_RATE);

    // reset endpoint flags
    silenceFramesRef.current = 0;
    inUtteranceRef.current = false;
    eofSentRef.current = false;

    setIsConnected(false);
  }, [closeWs]);

  const pauseASR = useCallback(() => {
    pausedRef.current = true;

    // Also stop sending / receiving by closing ws (prevents server late-loop spam)
    closeWs(true);

    // Suspend audio context (keeps graph)
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "running") {
      ctx.suspend();
    }

    setPartialTranscript("");
  }, [closeWs]);

  const resumeASR = useCallback(async () => {
    pausedRef.current = false;

    // reset endpoint flags so we start clean
    silenceFramesRef.current = 0;
    inUtteranceRef.current = false;
    eofSentRef.current = false;

    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") {
      await ctx.resume();
    }

    // We DON'T reconnect immediately; we'll reconnect when voice resumes (ensureWsOpen in onaudioprocess)
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    setPartialTranscript("");
    transcriptRef.current = "";
    lastFinalRef.current = "";
    lastPartialRef.current = "";
    recentFinalsRef.current = [];

    silenceFramesRef.current = 0;
    inUtteranceRef.current = false;
    eofSentRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      try { closeWs(false); } catch {}
      try { audioCtxRef.current?.close(); } catch {}
    };
  }, [closeWs]);

  return {
    transcript,
    partialTranscript,
    isConnected,
    audioBuffers,
    audioDuration,
    startASR,
    pauseASR,
    resumeASR,
    stopASR,
    resetTranscript,
  };
}

// -------------------- helpers --------------------

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? (s * 0x8000) : (s * 0x7fff);
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

function mergeTranscript(prev: string, next: string): string {
  const a = prev.trim();
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  if (containsNormalized(a, b)) return a;
  if (containsNormalized(b, a)) return b;
  if (b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;

  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  const max = Math.min(lowerA.length, lowerB.length);

  let overlap = 0;
  for (let i = max; i > 0; i--) {
    if (lowerA.slice(-i) === lowerB.slice(0, i)) {
      overlap = i;
      break;
    }
  }
  if (overlap > 0) return `${a}${b.slice(overlap)}`;
  return `${a} ${b}`;
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSameNormalized(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

function containsNormalized(container: string, content: string): boolean {
  const a = normalizeText(container);
  const b = normalizeText(content);
  if (!a || !b) return false;
  return a.includes(b);
}

function isLikelyRepeatedSegment(existing: string, incoming: string): boolean {
  const current = normalizeText(existing);
  const next = normalizeText(incoming);
  if (!current || !next) return false;

  if (current.includes(next)) return true;

  const tail = current.slice(-Math.max(240, next.length * 2));
  if (tail.includes(next)) return true;

  const nextWords = Array.from(new Set(next.split(" ").filter(Boolean)));
  const tailWords = new Set(tail.split(" ").filter(Boolean));
  if (nextWords.length < 6) return false;

  let common = 0;
  for (const w of nextWords) {
    if (tailWords.has(w)) common++;
  }
  return common / nextWords.length >= 0.85;
}

function computeRms(input: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    sum += s * s;
  }
  return Math.sqrt(sum / input.length);
}

function pushRecentFinal(target: string[], text: string) {
  const n = normalizeText(text);
  if (!n) return;
  target.push(n);
  if (target.length > 12) target.shift();
}

function isLoopingFinal(incoming: string, recent: string[]): boolean {
  const n = normalizeText(incoming);
  if (!n) return false;
  const words = n.split(" ").filter(Boolean);
  if (words.length < 8) return false;

  for (let i = recent.length - 1; i >= 0; i--) {
    if (wordSimilarity(n, recent[i]) >= 0.9) return true;
  }
  return false;
}

function wordSimilarity(a: string, b: string): number {
  const wa = a.split(" ").filter(Boolean);
  const wb = b.split(" ").filter(Boolean);
  if (!wa.length || !wb.length) return 0;
  const setA = new Set(wa);
  const setB = new Set(wb);

  let common = 0;
  for (const w of setA) {
    if (setB.has(w)) common++;
  }
  return common / Math.max(setA.size, setB.size);
}
