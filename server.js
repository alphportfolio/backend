/**
 * Voxly — Secure TTS Backend
 *
 * Proxies requests to Google Vertex AI (Gemini 2.5 Flash TTS).
 * Credentials live in service-account.json on the server only.
 * The frontend never sees the key.
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { GoogleAuth } = require('google-auth-library');

// ─────────────────────────────────────────────
// CONFIG  (edit these two lines if needed)
// ─────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0735472812';
const REGION  = process.env.VERTEX_REGION        || 'us-central1';

// Vertex AI endpoint for Gemini 2.5 Flash TTS
const VERTEX_TTS_URL =
  `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}` +
  `/locations/${REGION}/publishers/google/models/gemini-2.5-flash-preview-tts:generateContent`;

// Allowed TTS voices (same list your frontend already uses)
const ALLOWED_VOICES = new Set([
  'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede',
  'Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba',
  'Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar',
  'Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi',
  'Vindemiatrix','Sadachbia','Sulafat','Sadalbari',
]);

// ─────────────────────────────────────────────
// AUTH — GOOGLE_APPLICATION_CREDENTIALS tells
// google-auth-library where to find the key file.
// Set it before starting the server:
//   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
// OR just put it in your .env and use dotenv (see below).
// ─────────────────────────────────────────────
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  // If GOOGLE_APPLICATION_CREDENTIALS env var is set, this is automatic.
  // You can also pass keyFilename explicitly for extra clarity:
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json',
});

// ─────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────
const app = express();

// Serve your existing app.html (and other static files) from /public
app.use(express.static(path.join(__dirname, 'public')));

// Parse JSON bodies — limit size to prevent abuse
app.use(express.json({ limit: '64kb' }));

// CORS: in dev allow localhost; in production lock this down to your domain

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
// ─────────────────────────────────────────────
// POST /tts
//
// Request body:
//   { "text": "Hello world.", "voice": "Kore" }
//
// Response:
//   Content-Type: audio/wav
//   Body: raw WAV bytes
// ─────────────────────────────────────────────
app.post('/tts', async (req, res) => {
  try {
    const { text, voice } = req.body;

    // ── Input validation ──────────────────────
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required and must be a string.' });
    }
    if (text.length > 5000) {
      return res.status(400).json({ error: 'text must be 5000 characters or fewer.' });
    }
    const voiceName = (voice && typeof voice === 'string') ? voice : 'Kore';
    if (!ALLOWED_VOICES.has(voiceName)) {
      return res.status(400).json({ error: `Unknown voice: ${voiceName}` });
    }

    // ── Get a short-lived access token ────────
    // google-auth-library handles refresh automatically.
    const client      = await auth.getClient();
    const tokenResult = await client.getAccessToken();
    const accessToken = tokenResult.token;

    // ── Call Vertex AI ────────────────────────
    const vertexRes = await fetch(VERTEX_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type' : 'application/json',
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
      console.error('[TTS] Vertex AI error:', vertexRes.status, errBody);
      return res.status(502).json({ error: 'TTS service error. Check server logs.' });
    }

    const data = await vertexRes.json();

    // Extract base64 PCM audio from response
    const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) {
      return res.status(502).json({ error: 'No audio returned by TTS service.' });
    }

    // Convert base64 PCM → WAV buffer and send
    const wavBuffer = pcmBase64ToWav(b64);
    res.set('Content-Type', 'audio/wav');
    res.set('Cache-Control', 'no-store'); // audio is dynamic, don't cache
    res.send(wavBuffer);

  } catch (err) {
    console.error('[TTS] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────
// HEALTH CHECK  (useful for deployment)
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// ─────────────────────────────────────────────
// PCM base64 → WAV Buffer
// Same logic as your frontend pcmToWavBlob(),
// but runs server-side and returns a Node Buffer.
// ─────────────────────────────────────────────
function pcmBase64ToWav(b64, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const pcm        = Buffer.from(b64, 'base64');
  const byteRate   = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF',                           0);
  header.writeUInt32LE(36 + pcm.length,          4);
  header.write('WAVE',                           8);
  header.write('fmt ',                          12);
  header.writeUInt32LE(16,                      16); // PCM chunk size
  header.writeUInt16LE(1,                       20); // PCM format
  header.writeUInt16LE(channels,                22);
  header.writeUInt32LE(sampleRate,              24);
  header.writeUInt32LE(byteRate,                28);
  header.writeUInt16LE(blockAlign,              32);
  header.writeUInt16LE(bitsPerSample,           34);
  header.write('data',                          36);
  header.writeUInt32LE(pcm.length,              40);

  return Buffer.concat([header, pcm]);
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Voxly backend running at http://localhost:${PORT}`);
  console.log(`    Serving frontend from: /public`);
  console.log(`    TTS endpoint: POST /tts`);
  console.log(`    Vertex project: ${PROJECT} | region: ${REGION}`);
});

// ─────────────────────────────────────────────
// POST /ocr
// Proxies image text extraction to Google Vision API.
// Input:  { "imageBase64": "<base64 string>" }
// Output: { "text": "extracted text..." }
// ─────────────────────────────────────────────
app.post('/ocr', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 is required.' });
    }
    // Rough size check: base64 of a 10MB image is ~13MB string
    if (imageBase64.length > 14_000_000) {
      return res.status(400).json({ error: 'Image too large (max ~10MB).' });
    }

    const client      = await auth.getClient();
    const tokenResult = await client.getAccessToken();
    const accessToken = tokenResult.token;

    const visionRes = await fetch(
      'https://vision.googleapis.com/v1/images:annotate',
      {
        method: 'POST',
        headers: {
          'Content-Type' : 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          requests: [{
            image:    { content: imageBase64 },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
          }],
        }),
      }
    );

    if (!visionRes.ok) {
      const errBody = await visionRes.text();
      console.error('[OCR] Vision API error:', visionRes.status, errBody);
      return res.status(502).json({ error: 'OCR service error. Check server logs.' });
    }

    const data      = await visionRes.json();
    const extracted = data?.responses?.[0]?.fullTextAnnotation?.text || null;
    if (!extracted) {
      return res.status(422).json({ error: 'No text found in image.' });
    }

    res.json({ text: extracted.trim() });
  } catch (err) {
    console.error('[OCR] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
  app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});
});
