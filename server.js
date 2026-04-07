'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { GoogleAuth } = require('google-auth-library');

// 🔥 FIX: add fetch support for Node
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0735472812';
const REGION  = process.env.VERTEX_REGION        || 'us-central1';

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

const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : null;

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  credentials: credentials || undefined,
  keyFilename: credentials ? undefined : './service-account.json',
});

// ─────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────
const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '64kb' }));

app.use(cors({
  origin: '*', // 🔥 allow all for now (you can restrict later)
}));

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// ─────────────────────────────────────────────
// TTS
// ─────────────────────────────────────────────
app.post('/tts', async (req, res) => {
  try {
    const { text, voice } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required.' });
    }

    const voiceName = ALLOWED_VOICES.has(voice) ? voice : 'Kore';

    const client = await auth.getClient();
    const token  = (await client.getAccessToken()).token;

    const vertexRes = await fetch(VERTEX_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
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

    const data = await vertexRes.json();

    const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) return res.status(500).json({ error: 'No audio returned' });

    const wav = pcmBase64ToWav(b64);

    res.set('Content-Type', 'audio/wav');
    res.send(wav);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'TTS failed' });
  }
});

// ─────────────────────────────────────────────
// OCR
// ─────────────────────────────────────────────
app.post('/ocr', async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    const client = await auth.getClient();
    const token  = (await client.getAccessToken()).token;

    const visionRes = await fetch(
      'https://vision.googleapis.com/v1/images:annotate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          requests: [{
            image: { content: imageBase64 },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          }],
        }),
      }
    );

    const data = await visionRes.json();

    const text = data?.responses?.[0]?.fullTextAnnotation?.text;
    res.json({ text });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'OCR failed' });
  }
});

// ─────────────────────────────────────────────
// WAV CONVERTER
// ─────────────────────────────────────────────
function pcmBase64ToWav(b64) {
  const pcm = Buffer.from(b64, 'base64');
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

// ─────────────────────────────────────────────
// START (ONLY ONE LISTEN)
// ─────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
