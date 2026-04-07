'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { GoogleAuth } = require('google-auth-library');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const REGION  = process.env.VERTEX_REGION || 'us-central1';

if (!PROJECT) {
  console.error('FATAL: GOOGLE_CLOUD_PROJECT env var is not set.');
  process.exit(1);
}

const VERTEX_TTS_URL =
  `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}` +
  `/locations/${REGION}/publishers/google/models/gemini-2.5-flash-preview-tts:generateContent`;

const ALLOWED_VOICES = new Set([
  'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede',
  'Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba',
  'Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar',
  'Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi',
  'Vindemiatrix','Sadachbia','Sulafat','Sadalbari',
]);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
//
// Two modes — detected automatically:
//
//   RENDER (production):
//     Set env var  GOOGLE_SERVICE_ACCOUNT_JSON  = <paste entire JSON content>
//     (the raw text of your service-account.json file)
//
//   LOCAL (development):
//     Set env var  GOOGLE_APPLICATION_CREDENTIALS = ./service-account.json
//     (a file path, the normal ADC way)
// ─────────────────────────────────────────────────────────────────────────────
function buildAuth() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (rawJson) {
    // Production / Render — env var holds the JSON text itself
    let credentials;
    try {
      credentials = JSON.parse(rawJson);
    } catch (e) {
      console.error('FATAL: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', e.message);
      process.exit(1);
    }
    console.log('[auth] Using inline JSON credentials (GOOGLE_SERVICE_ACCOUNT_JSON)');
    return new GoogleAuth({
      credentials,   // pass parsed object, no file needed
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  // Local dev — key file path
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const auth = buildAuth();

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

// Serve static files (app.html etc.) from /public
app.use(express.static(path.join(__dirname, 'public')));

// JSON body parser — 64 kb limit prevents abuse
app.use(express.json({ limit: '64kb' }));

// CORS — allow same-origin requests AND any explicit FRONTEND_URL env var.
// When the frontend is served from the same Render service (/public), the
// browser sends requests with no Origin header → always allowed below.
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

app.use(cors({
  origin(origin, cb) {
    // No origin = same-origin request (or curl/Postman) — always allow
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin "${origin}" is not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
}));

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH  — both paths work (/health and /api/health match what Render expects)
// ─────────────────────────────────────────────────────────────────────────────
app.get(['/health', '/api/health'], (_req, res) => res.json({ status: 'ok' }));

// ─────────────────────────────────────────────────────────────────────────────
// POST /tts
// Body:    { "text": "...", "voice": "Kore" }
// Returns: audio/wav bytes
// ─────────────────────────────────────────────────────────────────────────────
app.post('/tts', async (req, res) => {
  try {
    const { text, voice } = req.body;

    // Validate input
    if (!text || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'text must be a non-empty string.' });
    }
    if (text.length > 5000) {
      return res.status(400).json({ error: 'text must be 5000 characters or fewer.' });
    }
    const voiceName = (typeof voice === 'string' && ALLOWED_VOICES.has(voice)) ? voice : 'Kore';

    // Get access token
    let accessToken;
    try {
      const client = await auth.getClient();
      const result = await client.getAccessToken();
      accessToken  = result.token;
      if (!accessToken) throw new Error('getAccessToken returned empty token');
    } catch (authErr) {
      console.error('[TTS] Auth error:', authErr.message);
      return res.status(500).json({ error: 'Server authentication failed. Check credentials.' });
    }

    // Call Vertex AI
    console.log(`[TTS] Calling Vertex AI | voice=${voiceName} | chars=${text.length}`);

    const vertexRes = await fetch(VERTEX_TTS_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      }),
    });

    if (!vertexRes.ok) {
      const errBody = await vertexRes.text();
      console.error(`[TTS] Vertex AI error ${vertexRes.status}:`, errBody);
      return res.status(502).json({
        error: `TTS upstream error ${vertexRes.status} — see Render logs for details.`,
      });
    }

    const data = await vertexRes.json();
    const b64  = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!b64) {
      console.error('[TTS] Vertex response had no audio. Full response:',
        JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'Vertex AI returned no audio data.' });
    }

    const wav = pcmBase64ToWav(b64);
    console.log(`[TTS] OK — sending ${wav.length} bytes`);

    res.set('Content-Type',  'audio/wav');
    res.set('Cache-Control', 'no-store');
    res.send(wav);

  } catch (err) {
    console.error('[TTS] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /ocr
// Body:    { "imageBase64": "..." }
// Returns: { "text": "..." }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/ocr', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 is required.' });
    }
    if (imageBase64.length > 14_000_000) {
      return res.status(400).json({ error: 'Image too large (max ~10MB).' });
    }

    let accessToken;
    try {
      const client = await auth.getClient();
      const result = await client.getAccessToken();
      accessToken  = result.token;
    } catch (authErr) {
      console.error('[OCR] Auth error:', authErr.message);
      return res.status(500).json({ error: 'Server authentication failed.' });
    }

    const visionRes = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: [{
          image:    { content: imageBase64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
        }],
      }),
    });

    if (!visionRes.ok) {
      const errBody = await visionRes.text();
      console.error(`[OCR] Vision API ${visionRes.status}:`, errBody);
      return res.status(502).json({ error: `OCR upstream error ${visionRes.status}.` });
    }

    const data      = await visionRes.json();
    const extracted = data?.responses?.[0]?.fullTextAnnotation?.text?.trim() || null;
    if (!extracted) return res.status(422).json({ error: 'No text found in image.' });

    res.json({ text: extracted });
  } catch (err) {
    console.error('[OCR] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PCM base64 → WAV Buffer
// ─────────────────────────────────────────────────────────────────────────────
function pcmBase64ToWav(b64, sr = 24000, ch = 1, bps = 16) {
  const pcm  = Buffer.from(b64, 'base64');
  const h    = Buffer.alloc(44);
  h.write('RIFF',                 0); h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE',                 8); h.write('fmt ',                 12);
  h.writeUInt32LE(16,            16); h.writeUInt16LE(1,              20);
  h.writeUInt16LE(ch,            22); h.writeUInt32LE(sr,             24);
  h.writeUInt32LE(sr * ch * bps / 8, 28); h.writeUInt16LE(ch * bps / 8, 32);
  h.writeUInt16LE(bps,           34); h.write('data',                 36);
  h.writeUInt32LE(pcm.length,    40);
  return Buffer.concat([h, pcm]);
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Voxly backend running on port ${PORT}`);
  console.log(`Project: ${PROJECT} | Region: ${REGION}`);
});
