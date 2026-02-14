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
const WS_URL =
  import.meta.env.DEV
    ? `ws://${location.host}/asr-ws/api/v1/lightning/get_text`
    : "wss://waves-api.smallest.ai/api/v1/lightning/get_text";

// Keep last ~120s of audio buffers in memory
const MAX_SAMPLES = SAMPLE_RATE * 120;

// Endpointing params (adaptive VAD + hard guards)
const RMS_MIN_THRESHOLD = 0.0015;
const NOISE_FLOOR_MIN = 0.0005;
const NOISE_FLOOR_ALPHA = 0.08;
const SPEECH_START_MULTIPLIER = 3.0;
const SPEECH_END_MULTIPLIER = 2.0;
const SPEECH_FRAMES_TO_START = 2;
const SILENCE_FRAMES_TO_EOF = 10; // ~1.28s with 2048/16k
const SILENCE_FRAMES_CLEAR_PARTIAL = 8;
const MAX_UTTERANCE_MS = 12000;
const NO_TRANSCRIPT_TIMEOUT_MS = 6000;

export function useASR(): UseASRReturn {
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [wordConfidences, setWordConfidences] = useState<Array<number | null>>([]);
  const [isConnected, setIsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  const audioBuffersRef = useRef<Float32Array[]>([]);
  const transcriptRef = useRef("");
  const wordConfidencesRef = useRef<Array<number | null>>([]);
  const partialRef = useRef("");

  const [audioBuffers, setAudioBuffers] = useState<Float32Array[]>([]);
  const [audioDuration, setAudioDuration] = useState(0);

  // Controls
  const pausedRef = useRef(false);
  const connectingRef = useRef<Promise<void> | null>(null);

  // Anti-repeat / dedupe
  const lastFinalRef = useRef("");
  const lastPartialRef = useRef("");
  const recentFinalsRef = useRef<string[]>([]);

  // Endpointing / VAD state
  const noiseFloorRef = useRef(RMS_MIN_THRESHOLD);
  const speechFramesRef = useRef(0);
  const silenceFramesRef = useRef(0);
  const inUtteranceRef = useRef(false);
  const eofSentRef = useRef(false);
  const utteranceStartedAtRef = useRef(0);
  const lastTranscriptUpdateAtRef = useRef(0);

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
      url.searchParams.set("word_timestamps", "true");
      url.searchParams.set("full_transcript", "false");

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);

      ws.onmessage = (event) => {
        try {
          if (pausedRef.current) return;

          const result: ASRResult = JSON.parse(event.data);
          logWordConfidences(result);

          if (result.is_final) {
            const finalText = (result.transcript || "").trim();

            if (!finalText) {
              partialRef.current = "";
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
            lastTranscriptUpdateAtRef.current = Date.now();

            const previousTranscript = transcriptRef.current;
            const previousConfidences = wordConfidencesRef.current;
            const finalWords = extractWordConfidences(result.words, finalText);
            const merged = mergeTranscript(previousTranscript, finalText);
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
          } else {
            const partialText = (result.transcript || "").trim();
            if (!partialText) {
              lastPartialRef.current = "";
              partialRef.current = "";
              setPartialTranscript("");
              return;
            }

            // If we already ended utterance, ignore partials too
            if (eofSentRef.current) return;

            if (isSameNormalized(partialText, lastPartialRef.current)) return;
            if (containsNormalized(transcriptRef.current, partialText)) return;

            lastPartialRef.current = partialText;
            partialRef.current = partialText;
            lastTranscriptUpdateAtRef.current = Date.now();
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
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (pausedRef.current) return;
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

  const startASR = useCallback(
    async (stream: MediaStream) => {
      // Reset state
      audioBuffersRef.current = [];
      setAudioBuffers([]);
      setAudioDuration(0);

      setPartialTranscript("");
      setTranscript("");
      setWordConfidences([]);
      transcriptRef.current = "";
      wordConfidencesRef.current = [];
      partialRef.current = "";

      lastFinalRef.current = "";
      lastPartialRef.current = "";
      recentFinalsRef.current = [];

      silenceFramesRef.current = 0;
      speechFramesRef.current = 0;
      noiseFloorRef.current = RMS_MIN_THRESHOLD;
      inUtteranceRef.current = false;
      eofSentRef.current = false;
      utteranceStartedAtRef.current = 0;
      lastTranscriptUpdateAtRef.current = Date.now();

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

      const bufferSize = 2048;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = async (e) => {
        if (pausedRef.current) return;

        const input = e.inputBuffer.getChannelData(0);
        const rms = computeRms(input);
        const now = Date.now();

        if (!inUtteranceRef.current) {
          const prevNoise = Math.max(NOISE_FLOOR_MIN, noiseFloorRef.current);
          // Update floor only when frame looks like background/noise.
          if (rms < prevNoise * SPEECH_START_MULTIPLIER) {
            noiseFloorRef.current = Math.max(
              NOISE_FLOOR_MIN,
              prevNoise * (1 - NOISE_FLOOR_ALPHA) + rms * NOISE_FLOOR_ALPHA
            );
          }
        }

        const speechStartThreshold = Math.max(
          RMS_MIN_THRESHOLD,
          noiseFloorRef.current * SPEECH_START_MULTIPLIER
        );
        const speechEndThreshold = Math.max(
          RMS_MIN_THRESHOLD,
          noiseFloorRef.current * SPEECH_END_MULTIPLIER
        );

        const endUtterance = () => {
          if (eofSentRef.current) return;
          eofSentRef.current = true;
          setPartialTranscript("");
          closeWs(true);
          inUtteranceRef.current = false;
          silenceFramesRef.current = 0;
          speechFramesRef.current = 0;
          utteranceStartedAtRef.current = 0;
        };

        // Not in utterance: wait for stable speech frames.
        if (!inUtteranceRef.current) {
          if (rms >= speechStartThreshold) {
            speechFramesRef.current += 1;
          } else {
            speechFramesRef.current = 0;
          }

          if (speechFramesRef.current < SPEECH_FRAMES_TO_START) {
            return;
          }

          inUtteranceRef.current = true;
          eofSentRef.current = false;
          silenceFramesRef.current = 0;
          speechFramesRef.current = 0;
          utteranceStartedAtRef.current = now;
          lastTranscriptUpdateAtRef.current = now;
          await ensureWsOpen();
        }

        if (rms < speechEndThreshold) {
          silenceFramesRef.current += 1;

          if (silenceFramesRef.current > SILENCE_FRAMES_CLEAR_PARTIAL) {
            setPartialTranscript("");
          }

          if (silenceFramesRef.current > SILENCE_FRAMES_TO_EOF) {
            endUtterance();
          }

          return;
        }

        silenceFramesRef.current = 0;

        if (utteranceStartedAtRef.current > 0) {
          const utteranceAge = now - utteranceStartedAtRef.current;
          const noTranscriptAge = now - lastTranscriptUpdateAtRef.current;
          if (utteranceAge > MAX_UTTERANCE_MS || noTranscriptAge > NO_TRANSCRIPT_TIMEOUT_MS) {
            endUtterance();
            return;
          }
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
    partialRef.current = "";

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
    speechFramesRef.current = 0;
    noiseFloorRef.current = RMS_MIN_THRESHOLD;
    inUtteranceRef.current = false;
    eofSentRef.current = false;
    utteranceStartedAtRef.current = 0;

    setIsConnected(false);
  }, [closeWs]);

  const pauseASR = useCallback(() => {
    const pendingPartial = partialRef.current.trim();
    if (pendingPartial) {
      const merged = mergeTranscript(transcriptRef.current, pendingPartial);
      const mergedConfidences = mergeWordConfidences(
        transcriptRef.current,
        wordConfidencesRef.current,
        tokenize(pendingPartial).map((word) => ({ word, confidence: null }))
      );
      transcriptRef.current = merged;
      wordConfidencesRef.current = mergedConfidences;
      setTranscript(merged);
      setWordConfidences(mergedConfidences);
      lastFinalRef.current = pendingPartial;
      partialRef.current = "";
    }

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
    speechFramesRef.current = 0;
    noiseFloorRef.current = RMS_MIN_THRESHOLD;
    inUtteranceRef.current = false;
    eofSentRef.current = false;
    utteranceStartedAtRef.current = 0;
    lastTranscriptUpdateAtRef.current = Date.now();

    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") {
      await ctx.resume();
    }

    // We DON'T reconnect immediately; we'll reconnect when voice resumes (ensureWsOpen in onaudioprocess)
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    setPartialTranscript("");
    setWordConfidences([]);
    transcriptRef.current = "";
    wordConfidencesRef.current = [];
    partialRef.current = "";
    lastFinalRef.current = "";
    lastPartialRef.current = "";
    recentFinalsRef.current = [];

    silenceFramesRef.current = 0;
    speechFramesRef.current = 0;
    noiseFloorRef.current = RMS_MIN_THRESHOLD;
    inUtteranceRef.current = false;
    eofSentRef.current = false;
    utteranceStartedAtRef.current = 0;
    lastTranscriptUpdateAtRef.current = Date.now();
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

function tokenize(s: string): string[] {
  const normalized = normalizeText(s);
  return normalized ? normalized.split(" ") : [];
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

  if (containsWordSequence(prevWords, nextWords)) {
    return prevConfs;
  }

  if (containsWordSequence(nextWords, prevWords)) {
    return nextConfs;
  }

  const max = Math.min(prevWords.length, nextWords.length);
  let overlap = 0;
  for (let size = max; size > 0; size--) {
    if (isWordArrayEqual(prevWords.slice(-size), nextWords.slice(0, size))) {
      overlap = size;
      break;
    }
  }

  if (overlap > 0) {
    return [...prevConfs, ...nextConfs.slice(overlap)];
  }

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
  console.groupCollapsed(
    `[ASR word confidence] ${result.is_final ? "final" : "partial"} (${rows.length})`
  );
  console.table(rows);
  console.groupEnd();
}
