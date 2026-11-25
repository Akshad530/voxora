# VOXORA server

Tiny Express proxy that keeps your Groq API key off the phone.

```
cd server
npm install
cp .env.example .env     # add GROQ_API_KEY, set APP_TOKEN
npm start                # http://localhost:8787/health
```

Endpoints: `POST /transcribe` (multipart audio → Whisper), `/format`, `/translate`, `/insights`, `/speakers`.
Deploy free on Render / Railway / Fly (set the same env vars) and put the HTTPS URL in the app's `.env`.
