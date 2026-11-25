import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

const {
  GROQ_API_KEY, APP_TOKEN = '', PORT = 8787,
  GROQ_STT_MODEL = 'whisper-large-v3', GROQ_LLM_MODEL = 'llama-3.3-70b-versatile', MAX_UPLOAD_MB = '25',
} = process.env;
const GROQ = 'https://api.groq.com/openai/v1';
const LANG_NAME = { en: 'English', hi: 'Hindi (Devanagari script)', mr: 'Marathi (Devanagari script)' };

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait a minute.' } }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(MAX_UPLOAD_MB) * 1024 * 1024 } });

app.get('/health', (_req, res) => res.json({ ok: true, stt: !!GROQ_API_KEY, llm: !!GROQ_API_KEY }));

app.use((req, res, next) => {
  if (APP_TOKEN && req.get('x-voxora-key') !== APP_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Server is missing GROQ_API_KEY.' });
  next();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function groq(path, init, tries = 3) {
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await fetch(GROQ + path, { ...init, headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...(init.headers || {}) } }); }
    catch { const err = new Error('Could not reach the AI provider from the server. Check the server’s internet connection.'); err.status = 502; throw err; }
    if (r.status === 429 && i < tries - 1) {
      const wait = Math.min(Number(r.headers.get('retry-after')) || 4 * (i + 1), 20);
      await sleep(wait * 1000);
      continue;
    }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) {
      const err = new Error(data?.error?.message || `Groq error ${r.status}`);
      err.status = r.status === 429 ? 429 : 502;
      throw err;
    }
    return data;
  }
}

async function chat(system, user, { json = false, temperature = 0.2 } = {}) {
  const data = await groq('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_LLM_MODEL, temperature,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

function chunk(text, max = 9000) {
  if (text.length <= max) return [text];
  const paras = text.split(/\n+/); const out = []; let cur = '';
  for (const p of paras) {
    if ((cur + '\n' + p).length > max && cur) { out.push(cur); cur = p; } else cur = cur ? cur + '\n' + p : p;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}

const RULES = (lang) => `Always write in ${LANG_NAME[lang] || 'the same language as the input'}. Never add facts that are not in the source. Output only the result, with no preface or commentary.`;
const MODE_PROMPTS = {
  clean: (l) => `You clean up speech-to-text transcripts. Fix punctuation, capitalization and obvious recognition slips, remove filler words (um, uh, you know) and stutters, and split the text into natural paragraphs. Keep the speaker's wording and meaning. ${RULES(l)}`,
  study: (l) => `Turn this spoken lecture/explanation into well-organised study notes: short headings (prefix with "## "), concise bullet points (prefix with "- "), bold key terms using **term**, and a short "Quick revision" list at the end. ${RULES(l)}`,
  professional: (l) => `Rewrite this dictation as polished, professional prose suitable for a report or business document. Fix grammar, tighten phrasing, keep a confident neutral tone, use clear paragraphs. ${RULES(l)}`,
  email: (l) => `Turn this dictation into a ready-to-send professional email. Start with "Subject: ...", then a greeting, a concise body in short paragraphs, and a courteous sign-off (use "[Your name]" as the name). ${RULES(l)}`,
  meeting: (l) => `Turn this transcript into structured meeting notes with these headings (prefix with "## "): Overview, Key Discussion Points, Decisions, Action Items (with owner if mentioned), Next Steps. Use "- " bullets. Skip any heading with no content. ${RULES(l)}`,
  bullets: (l) => `Convert this transcript into clear, scannable bullet points grouped under short topic headings (prefix headings with "## ", bullets with "- "). ${RULES(l)}`,
};

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error(e.message);
    res.status(e.status || 500).json({ error: e.status === 429 ? 'The AI provider is rate-limiting requests. Please try again in a minute.' : e.message || 'Server error' });
  }
};

app.post('/transcribe', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file received.' });
  const lang = ['en', 'hi', 'mr'].includes(req.body.language) ? req.body.language : 'en';
  const form = new FormData();
  form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/m4a' }), req.file.originalname || 'audio.m4a');
  form.append('model', GROQ_STT_MODEL);
  form.append('language', lang);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  const data = await groq('/audio/transcriptions', { method: 'POST', body: form });
  const segments = (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })).filter((s) => s.text);
  res.json({ text: String(data.text || '').trim(), segments, duration: data.duration ?? segments.at(-1)?.end ?? 0, language: lang });
}));

app.post('/format', wrap(async (req, res) => {
  const { text, mode = 'clean', lang = 'en' } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'No text to format.' });
  const sys = (MODE_PROMPTS[mode] || MODE_PROMPTS.clean)(lang);
  const parts = chunk(text.trim());
  const out = [];
  for (const p of parts) out.push(await chat(sys, p, { temperature: 0.2 }));
  res.json({ text: out.join('\n\n') });
}));

app.post('/translate', wrap(async (req, res) => {
  const { text, target = 'en', source = 'en' } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'No text to translate.' });
  const sys = `You are a professional translator. Translate from ${LANG_NAME[source] || source} to ${LANG_NAME[target] || target}. Preserve meaning, tone, paragraph breaks, headings and bullet markers (## and -). Output only the translation.`;
  const out = [];
  for (const p of chunk(text.trim())) out.push(await chat(sys, p, { temperature: 0.1 }));
  res.json({ text: out.join('\n\n') });
}));

app.post('/insights', wrap(async (req, res) => {
  const { text, segments = [], lang = 'en' } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'No text to analyse.' });
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const hasTime = segments.length > 0;
  const source = hasTime ? segments.map((s) => `[${s.start.toFixed(0)}s] ${s.text}`).join('\n') : text;
  const trimmed = source.length > 24000 ? source.slice(0, 24000) : source;
  const sys = `You analyse transcripts. Return ONLY a JSON object: {"summary": string (2-4 sentences), "keyPoints": string[] (3-7), "actionItems": string[] (0-7, only tasks actually stated), "chapters": [{"start": number (seconds), "title": string}] (${hasTime ? '3-8 chapters using the [Ns] markers, ascending' : 'empty array because there are no timestamps'})}. Write all strings in ${LANG_NAME[lang] || 'English'}. Never invent content.`;
  const raw = await chat(sys, trimmed, { json: true, temperature: 0.2 });
  let o; try { o = JSON.parse(raw); } catch { return res.status(502).json({ error: 'AI returned an unreadable response. Try again.' }); }
  res.json({
    summary: String(o.summary || ''),
    keyPoints: Array.isArray(o.keyPoints) ? o.keyPoints.map(String) : [],
    actionItems: Array.isArray(o.actionItems) ? o.actionItems.map(String) : [],
    chapters: hasTime && Array.isArray(o.chapters) ? o.chapters.filter((c) => typeof c.start === 'number').map((c) => ({ start: c.start, title: String(c.title) })) : [],
    _clock: undefined,
  });
}));

app.post('/speakers', wrap(async (req, res) => {
  const { segments = [] } = req.body || {};
  if (!segments.length) return res.status(400).json({ error: 'No segments to analyse.' });
  const list = segments.slice(0, 400).map((s, i) => `${i}: ${s.text}`).join('\n');
  const sys = `You label conversation turns by speaker, based only on the text (turn-taking, questions/answers, address terms). Return ONLY JSON: {"speakers": string[]} with exactly one label per numbered line, using "Speaker 1", "Speaker 2", ... Use a single speaker if it is a monologue. Be conservative.`;
  const raw = await chat(sys, list, { json: true, temperature: 0 });
  let o; try { o = JSON.parse(raw); } catch { return res.status(502).json({ error: 'AI returned an unreadable response. Try again.' }); }
  const sp = Array.isArray(o.speakers) ? o.speakers.map(String) : [];
  const out = segments.map((_, i) => sp[i] || sp[i - 1] || 'Speaker 1');
  res.json({ speakers: out });
}));

app.listen(PORT, '0.0.0.0', () => console.log(`VOXORA server listening on :${PORT}  (STT=${GROQ_STT_MODEL}, LLM=${GROQ_LLM_MODEL})`));
