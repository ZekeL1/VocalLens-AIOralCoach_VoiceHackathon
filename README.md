# VocalLens AI

VocalLens AI is an AI-powered English speaking practice app.  
It turns reading practice into a full feedback loop: live recognition, word-level confidence, post-session coaching, and spoken feedback playback.

## What We Built

This project delivers an end-to-end oral practice workflow:

- Real-time ASR transcription with per-word confidence visualization.
- AI-generated reference sentences (Groq) for varied speaking practice.
- Post-session pronunciation evaluation (Groq) with actionable advice.
- Text-to-speech playback of feedback (Smallest AI), so learners can listen to coaching tips.
- A frontend/backend split where secrets stay on the backend.

## Why We Built It

Many speaking tools only provide a final score.  
We built VocalLens AI to answer a more useful question: **what exactly should the learner improve next?**

Key goals:

- Show weak spots at the word level, not only aggregate scores.
- Keep practice fresh with dynamically generated prompts.
- Convert evaluation into concrete drills and corrections.
- Reduce friction by reading feedback aloud.

## Core Features

1. **Reference Text Generation**
- Clicking `Generate` calls `POST /api/generate-reference-text`.
- Backend uses Groq to create one short practice sentence.

2. **Live Recording + ASR**
- `useASR` handles microphone capture, websocket streaming, partial/final merge logic, and confidence alignment.
- Pause/resume/stop edge cases are handled to reduce confidence instability near utterance boundaries.

3. **Pronunciation Evaluation**
- On `Finish`, frontend sends reference text, ASR transcript, confidence array, and score to `POST /api/evaluate-pronunciation`.
- Backend returns structured feedback (assessment, issues, drills).

4. **Feedback Playback**
- Frontend calls `POST /api/speak-feedback` to synthesize and play coaching audio.

## Tech Stack

- Frontend: `React + Vite + TypeScript + Tailwind + shadcn/ui`
- Backend: `Node.js + Express` (`backend/server.js`)
- LLM: `Groq`
- ASR/TTS: `Smallest AI`
- Supabase: token helper function for ASR key access



## How To Run Locally

# NOTE: add your own api keys and models into your own local environment

1. Install frontend dependencies:

```bash
npm install
```

2. Install and start backend:

```bash
cd backend
npm install
npm run dev
```

3. Start frontend in another terminal (from repo root):

```bash
npm run dev
```

4. Verify backend health:

```bash
curl http://localhost:3001/health
```

Expected response:

```json
{"ok":true}
```

## Troubleshooting

- `Generate` shows `Failed to fetch`:
  backend is not running or `VITE_BACKEND_URL` is wrong.
- `502` from backend:
  check `GROQ_API_KEY`, model name, and backend logs.
- ASR websocket issues in dev:
  verify root `.env` contains `SMALLEST_AI_API_KEY` and Supabase token function is configured.
