# VocalLens AI

VocalLens AI is an English pronunciation practice app that combines live ASR, Azure pronunciation scoring, and spoken AI coaching in one workflow.

## What We Built

We built an end-to-end speaking practice loop:

1. Generate a reference sentence for practice (Groq).
2. Record and transcribe speech in real time (Smallest AI ASR over WebSocket).
3. Submit recorded WAV audio for pronunciation assessment (Azure Speech Pronunciation Assessment).
4. Show final score, radar-style pronunciation signature (SVG), and weak-word diagnostics.
5. Read feedback aloud with TTS (Smallest AI).

## Why We Built It

Most speaking tools return a single score without actionable detail. This project is designed to answer:

- Which words were weak?
- Which pronunciation dimensions were weak (clarity, stress, consonants, vowels, fluency)?
- What should the learner practice next?

## Tech Stack (Actually Used)

Frontend
- React + Vite + TypeScript
- Tailwind CSS + shadcn/ui
- Framer Motion
- WaveSurfer.js (live waveform)

Backend
- Node.js + Express (`backend/server.js`)
- Azure Speech Pronunciation Assessment (scoring)
- Groq (reference text generation)
- Smallest AI TTS (feedback voice playback)

ASR + Token Delivery
- Smallest AI streaming ASR (WebSocket)
- Supabase Edge Function `get-asr-token` for token return
- Vite dev proxy for `/asr-ws` WebSocket header injection

## Core Runtime Flow and Code Paths

### 1) Practice Sentence Generation
- Frontend trigger: `src/pages/Index.tsx` -> `handleGenerateReferenceText()`
- Backend endpoint: `POST /api/generate-reference-text` in `backend/server.js`
- Key backend functions used:
  - `requestSentenceFromGroq()`
  - `sanitizeSentence()`
  - `containsContraction()`
  - `clampInt()`

### 2) Real-Time ASR Capture and Transcript
- Frontend hook: `src/hooks/useASR.ts`
- Key functions used in runtime:
  - `startASR()` to create audio graph + WS session
  - `connectWs()` / `ensureWsOpen()` for WebSocket lifecycle
  - `pauseASR()` / `resumeASR()` / `stopASR()`
  - `commitPendingPartial()` to preserve final partial text on pause/stop
  - `mergeTranscript()` + `mergeWordConfidences()` for stable transcript/confidence alignment
  - `getRecordedWavBase64()` + `encodeWavBase64()` for Azure submission payload

### 3) Final Pronunciation Scoring (Azure)
- Frontend trigger: `finishSession()` in `src/pages/Index.tsx`
- Backend endpoint: `POST /api/evaluate-pronunciation-azure` in `backend/server.js`
- Azure response parsing/scoring functions used:
  - `pickBestNBest()`
  - `pickBestScore()`
  - `clampScore()`
  - `isVowelPhone()`
  - `deriveCriticalPoints()`
  - `deriveActionDrill()`
- Caching/persistence functions used:
  - `buildAnalysisCacheKey()`
  - `getCachedAnalysis()`
  - `finalizeAzureAnalysis()`

### 4) UI Analysis Rendering
- Transcript coloring + confidence display:
  - `src/components/TranscriptionDisplay.tsx`
  - `src/lib/scoring.ts` -> `diffWords()`
- Signature chart SVG rendering:
  - `src/components/PronunciationSignature.tsx`
- Azure word accuracy mapping back to displayed tokens:
  - `buildAzureWordConfidences()` in `src/pages/Index.tsx`

### 5) Spoken Feedback Playback
- Frontend trigger: `speakEvaluation()` in `src/pages/Index.tsx`
- Backend endpoint: `POST /api/speak-feedback` in `backend/server.js`
- External API call: Smallest AI TTS (`lightning-v2/get_speech`)

## Environment Variables

### Root `.env` (frontend)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PROJECT_ID`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_BACKEND_URL` (optional, default `http://localhost:3001`)
- `SMALLEST_AI_API_KEY` (used by Vite proxy for `/asr-ws` in local dev)

### `backend/.env`
- `GROQ_API_KEY`
- `GROQ_MODEL` (optional, default `llama-3.1-8b-instant`)
- `SPEECH_API_KEY` (or `SPEECH_KEY`)
- `SPEECH_REGION`
- `SMALLEST_AI_API_KEY`
- `SMALLEST_TTS_VOICE_ID`
- `PORT` (optional, default `3001`)

### Supabase Edge Function Secrets
- `SMALLEST_AI_API_KEY` for `supabase/functions/get-asr-token`

## How to Run Locally

1. Install frontend dependencies

```bash
npm install
```

2. Install and start backend

```bash
cd backend
npm install
npm run dev
```

3. Start frontend (new terminal at project root)

```bash
npm run dev
```

4. Health check backend

```bash
curl http://localhost:3001/health
```

Expected result:

```json
{"ok":true}
```

## Data and Storage Behavior

- Audio submitted at Finish is persisted to: `backend/data/audio/`
- Azure analysis cache is persisted to: `backend/data/analysis-cache.json`
- Re-running the same audio + reference text can hit cache and return consistent output faster.

## Troubleshooting

- `Failed to fetch` from frontend
  - Check backend is running at `http://localhost:3001`
  - Check `VITE_BACKEND_URL`

- Browser CORS errors
  - Ensure backend is running and reachable; `server.js` enables CORS headers

- `PayloadTooLargeError`
  - Keep recording shorter, or increase `express.json({ limit })` in `backend/server.js`

- Azure returns fallback/no metrics
  - Verify `SPEECH_API_KEY` and `SPEECH_REGION`
  - Confirm WAV payload is non-empty and 16k PCM format from `useASR`

- ASR does not stream in dev
  - Confirm root `.env` has `SMALLEST_AI_API_KEY` (for Vite proxy header)
  - Confirm Supabase `get-asr-token` function is deployed and accessible

## Demo Summary

In one session, VocalLens lets a user generate a sentence, read it aloud, receive Azure-backed pronunciation scoring, inspect weak words and signature dimensions, and listen to TTS coaching immediately.
