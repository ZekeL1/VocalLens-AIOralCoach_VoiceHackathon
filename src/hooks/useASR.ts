import { useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ASRResult {
  transcript: string;
  is_final: boolean;
  is_last?: boolean;
  session_id?: string;
  words?: ASRWord[];
}

interface ASRWord {
  word?: string;
  text?: string;
  confidence?: number;
  start?: number;
  end?: number;
}

export interface UseASRReturn {
  transcript: string;
  partialTranscript: string;
  wordConfidences: Array<number | null>;
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
const PARTIAL_IDLE_COMMIT_MS = 2200;
const STOP_FINAL_WAIT_MS = 1800;
const WS_URL =
  import.meta.env.DEV
    ? `ws://${location.host}/asr-ws/api/v1/lightning/get_text`
    : "wss://waves-api.smallest.ai/api/v1/lightning/get_text";

// Keep last ~120s of audio buffers in memory
const MAX_SAMPLES = SAMPLE_RATE * 120;

export function useASR(): UseASRReturn {
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [wordConfidences, setWordConfidences] = useState<Array<number | null>>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [audioBuffers, setAudioBuffers] = useState<Float32Array[]>([]);
  const [audioDuration, setAudioDuration] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const connectingRef = useRef<Promise<void> | null>(null);
  const capturePausedRef = useRef(false);
  const partialCommitTimerRef = useRef<number | null>(null);
  const stopRequestedRef = useRef(false);
  const stopTimeoutRef = useRef<number | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  const transcriptRef = useRef("");
  const partialRef = useRef("");
  const wordConfidencesRef = useRef<Array<number | null>>([]);
  const audioBuffersRef = useRef<Float32Array[]>([]);

  const lastFinalNormalizedRef = useRef("");
  const lastPartialNormalizedRef = useRef("");

  const fetchToken = useCallback(async (): Promise<string> => {
    const { data, error } = await supabase.functions.invoke("get-asr-token");
    if (error) throw new Error("Failed to fetch ASR token");
    return data.token;
  }, []);

  const closeWs = useCallback((sendEof: boolean) => {
    stopRequestedRef.current = false;

    if (stopTimeoutRef.current !== null) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }

    if (partialCommitTimerRef.current !== null) {
      window.clearTimeout(partialCommitTimerRef.current);
      partialCommitTimerRef.current = null;
    }

    const ws = wsRef.current;
    if (!ws) return;

    try {
      if (sendEof && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ eof: true }));
      }
    } catch (err) {
      console.debug("[ASR] eof send failed", err);
    }

    try {
      ws.close();
    } catch (err) {
      console.debug("[ASR] ws close failed", err);
    }

    wsRef.current = null;
    setIsConnected(false);
  }, []);

  const commitPendingPartial = useCallback(() => {
    const pendingPartial = partialRef.current.trim();
    if (!pendingPartial) return;
    if (containsNormalized(transcriptRef.current, pendingPartial)) {
      partialRef.current = "";
      setPartialTranscript("");
      return;
    }

    const previousTranscript = transcriptRef.current;
    const previousConfidences = wordConfidencesRef.current;
    const merged = mergeTranscript(previousTranscript, pendingPartial);
    const mergedConfidences = mergeWordConfidences(
      previousTranscript,
      previousConfidences,
      tokenize(pendingPartial).map((word) => ({ word, confidence: null }))
    );

    transcriptRef.current = merged;
    wordConfidencesRef.current = mergedConfidences;
    setTranscript(merged);
    setWordConfidences(mergedConfidences);
    lastFinalNormalizedRef.current = normalizeText(pendingPartial);
    lastPartialNormalizedRef.current = "";
    partialRef.current = "";
    setPartialTranscript("");
  }, []);

  const connectWs = useCallback(async (token: string) => {
    // Always close old ws before new one.
    closeWs(false);

    const url = new URL(WS_URL);
    url.searchParams.set("authorization", `Bearer ${token}`);
    url.searchParams.set("language", "en");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(SAMPLE_RATE));
    url.searchParams.set("word_timestamps", "true");
    url.searchParams.set("full_transcript", "false");

    const ws = new WebSocket(url.toString());
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const result: ASRResult = JSON.parse(event.data);
        logWordConfidences(result);

        const maybeCloseAfterLast = () => {
          if (stopRequestedRef.current && result.is_last) {
            closeWs(false);
          }
        };

        if (result.is_final) {
          const finalText = (result.transcript || "").trim();
          if (!finalText) {
            partialRef.current = "";
            setPartialTranscript("");
            if (partialCommitTimerRef.current !== null) {
              window.clearTimeout(partialCommitTimerRef.current);
              partialCommitTimerRef.current = null;
            }
            maybeCloseAfterLast();
            return;
          }

          const finalNormalized = normalizeText(finalText);
          const previousTranscript = transcriptRef.current;
          const merged = mergeTranscript(previousTranscript, finalText);

          lastFinalNormalizedRef.current = finalNormalized;
          lastPartialNormalizedRef.current = "";

          const previousConfidences = wordConfidencesRef.current;
          const finalWords = extractWordConfidences(result.words, finalText);
          const mergedConfidences = mergeWordConfidences(
            previousTranscript,
            previousConfidences,
            finalWords
          );

          transcriptRef.current = merged;
          wordConfidencesRef.current = mergedConfidences;
          setTranscript(merged);
          setWordConfidences(mergedConfidences);

          partialRef.current = "";
          setPartialTranscript("");
          if (partialCommitTimerRef.current !== null) {
            window.clearTimeout(partialCommitTimerRef.current);
            partialCommitTimerRef.current = null;
          }
          maybeCloseAfterLast();
          return;
        }

        const partialText = (result.transcript || "").trim();
        if (!partialText) {
          partialRef.current = "";
          lastPartialNormalizedRef.current = "";
          setPartialTranscript("");
          if (partialCommitTimerRef.current !== null) {
            window.clearTimeout(partialCommitTimerRef.current);
            partialCommitTimerRef.current = null;
          }
          maybeCloseAfterLast();
          return;
        }

        const partialNormalized = normalizeText(partialText);
        if (partialNormalized === lastPartialNormalizedRef.current) return;

        lastPartialNormalizedRef.current = partialNormalized;
        partialRef.current = partialText;
        setPartialTranscript(partialText);
        if (partialCommitTimerRef.current !== null) {
          window.clearTimeout(partialCommitTimerRef.current);
        }
        partialCommitTimerRef.current = window.setTimeout(() => {
          partialCommitTimerRef.current = null;
          const ws = wsRef.current;
          const wsAlive =
            !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
          // Do not prematurely freeze text during active streaming.
          if (!capturePausedRef.current && wsAlive) return;
          commitPendingPartial();
        }, PARTIAL_IDLE_COMMIT_MS);
        maybeCloseAfterLast();
      } catch (err) {
        console.warn("[ASR] Failed to parse message:", err);
      }
    };

    ws.onerror = (event) => {
      console.error("[ASR] WebSocket error:", event);
    };

    ws.onclose = (event) => {
      console.debug("[ASR] ws closed", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      if (partialRef.current.trim()) {
        commitPendingPartial();
      }
      setIsConnected(false);
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [closeWs, commitPendingPartial]);

  const ensureWsOpen = useCallback(async () => {
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (capturePausedRef.current) return;
    if (stopRequestedRef.current) return;
    if (connectingRef.current) {
      await connectingRef.current;
      return;
    }

    connectingRef.current = (async () => {
      const token = await fetchToken();
      await connectWs(token);
    })();

    try {
      await connectingRef.current;
    } finally {
      connectingRef.current = null;
    }
  }, [connectWs, fetchToken]);

  const teardownAudioGraph = useCallback(async () => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch (err) {
        console.debug("[ASR] processor disconnect failed", err);
      }
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch (err) {
        console.debug("[ASR] source disconnect failed", err);
      }
      sourceRef.current = null;
    }
    if (gainRef.current) {
      try {
        gainRef.current.disconnect();
      } catch (err) {
        console.debug("[ASR] gain disconnect failed", err);
      }
      gainRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close();
      } catch (err) {
        console.debug("[ASR] audio context close failed", err);
      }
      audioCtxRef.current = null;
    }
  }, []);

  const startASR = useCallback(async (stream: MediaStream) => {
    // Reset session state
    audioBuffersRef.current = [];
    setAudioBuffers([]);
    setAudioDuration(0);

    setTranscript("");
    transcriptRef.current = "";
    setPartialTranscript("");
    partialRef.current = "";
    setWordConfidences([]);
    wordConfidencesRef.current = [];
    lastFinalNormalizedRef.current = "";
    lastPartialNormalizedRef.current = "";

    capturePausedRef.current = false;

    // Build WS and audio graph
    const token = await fetchToken();
    await connectWs(token);
    await teardownAudioGraph();

    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    gainRef.current = gain;

    const processor = audioCtx.createScriptProcessor(2048, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = async (event) => {
      if (capturePausedRef.current) return;

      const input = event.inputBuffer.getChannelData(0);
      await ensureWsOpen();

      const copy = new Float32Array(input.length);
      copy.set(input);
      pushWithCap(audioBuffersRef.current, copy, MAX_SAMPLES);

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const pcm16 = float32ToInt16(input);
        ws.send(pcm16 as unknown as ArrayBuffer);
      }
    };

    source.connect(processor);
    processor.connect(gain);
    gain.connect(audioCtx.destination);
  }, [connectWs, ensureWsOpen, fetchToken, teardownAudioGraph]);

  const stopASR = useCallback(() => {
    capturePausedRef.current = true;

    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "running") {
      void ctx.suspend();
    }

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      stopRequestedRef.current = true;
      try {
        ws.send(JSON.stringify({ eof: true }));
      } catch (err) {
        console.debug("[ASR] eof send failed", err);
      }

      if (stopTimeoutRef.current !== null) {
        window.clearTimeout(stopTimeoutRef.current);
      }
      stopTimeoutRef.current = window.setTimeout(() => {
        stopTimeoutRef.current = null;
        if (!stopRequestedRef.current) return;
        commitPendingPartial();
        closeWs(false);
      }, STOP_FINAL_WAIT_MS);
    } else {
      commitPendingPartial();
      closeWs(false);
    }

    void teardownAudioGraph();

    const buffers = audioBuffersRef.current;
    setAudioBuffers([...buffers]);
    const totalSamples = buffers.reduce((sum, chunk) => sum + chunk.length, 0);
    setAudioDuration(totalSamples / SAMPLE_RATE);

    setIsConnected(false);
  }, [closeWs, commitPendingPartial, teardownAudioGraph]);

  const pauseASR = useCallback(() => {
    capturePausedRef.current = true;
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "running") {
      void ctx.suspend();
    }
  }, []);

  const resumeASR = useCallback(async () => {
    capturePausedRef.current = false;
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") {
      await ctx.resume();
    }
    await ensureWsOpen();
  }, [ensureWsOpen]);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    setPartialTranscript("");
    setWordConfidences([]);

    transcriptRef.current = "";
    partialRef.current = "";
    wordConfidencesRef.current = [];
    lastFinalNormalizedRef.current = "";
    lastPartialNormalizedRef.current = "";
  }, []);

  useEffect(() => {
    return () => {
      if (partialCommitTimerRef.current !== null) {
        window.clearTimeout(partialCommitTimerRef.current);
        partialCommitTimerRef.current = null;
      }
      closeWs(false);
      void teardownAudioGraph();
    };
  }, [closeWs, teardownAudioGraph]);

  return {
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
  let total = target.reduce((sum, block) => sum + block.length, 0);
  while (total > maxSamples && target.length > 1) {
    const removed = target.shift();
    total -= removed?.length || 0;
  }
}

function mergeTranscript(prev: string, next: string): string {
  const a = tokenize(prev);
  const b = tokenize(next);
  if (!a.length) return b.join(" ");
  if (!b.length) return a.join(" ");
  if (isWordArrayEqual(a, b)) return a.join(" ");
  if (containsWordSequence(a, b)) return a.join(" ");
  if (containsWordSequence(b, a)) return b.join(" ");

  const max = Math.min(a.length, b.length);
  let overlap = 0;
  for (let size = max; size > 0; size--) {
    if (isWordArrayEqual(a.slice(-size), b.slice(0, size))) {
      overlap = size;
      break;
    }
  }
  return [...a, ...b.slice(overlap)].join(" ");
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ") : [];
}

function containsNormalized(container: string, content: string): boolean {
  const a = normalizeText(container);
  const b = normalizeText(content);
  if (!a || !b) return false;
  return a.includes(b);
}

function normalizeConfidence(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

function extractWordConfidences(words: ASRWord[] | undefined, fallbackText: string) {
  if (!Array.isArray(words) || words.length === 0) {
    return tokenize(fallbackText).map((word) => ({ word, confidence: null as number | null }));
  }

  const output: Array<{ word: string; confidence: number | null }> = [];
  for (const item of words) {
    const tokenText = item.word ?? item.text ?? "";
    const parts = tokenize(tokenText);
    if (!parts.length) continue;
    const confidence = normalizeConfidence(item.confidence);
    for (const part of parts) {
      output.push({ word: part, confidence });
    }
  }

  if (output.length > 0) return output;
  return tokenize(fallbackText).map((word) => ({ word, confidence: null as number | null }));
}

function mergeWordConfidences(
  previousTranscript: string,
  previousConfidences: Array<number | null>,
  incoming: Array<{ word: string; confidence: number | null }>
) {
  const prevWords = tokenize(previousTranscript);
  const prevConfs = alignConfidences(prevWords.length, previousConfidences);
  const nextWords = incoming.map((item) => item.word);
  const nextConfs = incoming.map((item) => item.confidence);

  if (!prevWords.length) return nextConfs;
  if (!nextWords.length) return prevConfs;

  if (containsWordSequence(prevWords, nextWords)) return prevConfs;
  if (containsWordSequence(nextWords, prevWords)) return nextConfs;

  const max = Math.min(prevWords.length, nextWords.length);
  let overlap = 0;
  for (let size = max; size > 0; size--) {
    if (isWordArrayEqual(prevWords.slice(-size), nextWords.slice(0, size))) {
      overlap = size;
      break;
    }
  }

  if (overlap > 0) return [...prevConfs, ...nextConfs.slice(overlap)];
  return [...prevConfs, ...nextConfs];
}

function alignConfidences(length: number, confidences: Array<number | null>) {
  if (confidences.length === length) return [...confidences];
  if (confidences.length > length) return confidences.slice(0, length);
  return [...confidences, ...Array.from({ length: length - confidences.length }, () => null)];
}

function isWordArrayEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function containsWordSequence(container: string[], content: string[]) {
  if (!container.length || !content.length || content.length > container.length) return false;
  const maxStart = container.length - content.length;
  for (let start = 0; start <= maxStart; start++) {
    if (isWordArrayEqual(container.slice(start, start + content.length), content)) {
      return true;
    }
  }
  return false;
}

function logWordConfidences(result: ASRResult) {
  if (!Array.isArray(result.words) || result.words.length === 0) return;

  const rows = result.words
    .map((word, index) => {
      const token = word.word ?? word.text ?? "";
      const confidence = typeof word.confidence === "number" ? word.confidence : null;
      return {
        index,
        word: token,
        confidence,
        confidencePercent: confidence === null ? null : Number((confidence * 100).toFixed(1)),
        start: typeof word.start === "number" ? Number(word.start.toFixed(3)) : null,
        end: typeof word.end === "number" ? Number(word.end.toFixed(3)) : null,
        isFinal: result.is_final,
      };
    })
    .filter((row) => row.word || row.confidence !== null);

  if (!rows.length) return;
  console.groupCollapsed(`[ASR word confidence] ${result.is_final ? "final" : "partial"} (${rows.length})`);
  console.table(rows);
  console.groupEnd();
}

