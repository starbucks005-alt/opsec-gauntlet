/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Podcast-Style Reviewer

   Two passes:
     1. Claude generates a podcast transcript: two hosts discuss the manuscript
        in the requested tone (scholarly / witty / casual). Pacing, character
        arcs, structure. Anti-sycophancy applies.
     2. ElevenLabs renders each speaker line into audio with two distinct
        voices (Rachel + Adam by default), concatenated into a single MP3,
        uploaded to Supabase Storage bucket 'playground-audio', returns
        public URL.

   Cost: 30 credits per generation.
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const crypto = require('crypto');

const MODEL = 'claude-sonnet-4-6';
const COST = 30;
const TEXT_CAP = 80000;

const HOST_VOICES = {
  // Default ElevenLabs library voices
  A: { name: 'Rachel',  voice_id: '21m00Tcm4TlvDq8ikWAM' },
  B: { name: 'Adam',    voice_id: 'nPczCjzI2devNBz1zQrb' },
};

const TONE_BRIEFS = {
  scholarly: 'Two literary critics in a scholarly podcast. Precise, rigorous, comfortable with literary terms. They cite scenes by chapter and approach the work as a serious craft object. They challenge each other.',
  witty:     'Two book-podcast co-hosts with sharp comedic timing. They tease each other but never the author. Banter punctuates real critique. Riffs are short; analysis is concrete.',
  casual:    'Two readers in a friendly book-club conversation. Plain language, no jargon. They tell each other what worked and what lost them. Honest, warm, but specific.',
};

const EPISODE_STRUCTURE = {
  critique: `The episode covers, in this order:
  1. Cold-open hook: a single sharp observation that sets the episode's argument.
  2. Pacing: where the manuscript moves, where it stalls.
  3. Character arcs: who earns their journey, who does not.
  4. Structural integrity: do scenes accomplish what scenes need to accomplish.
  5. The verdict: would these hosts recommend this manuscript? In what form?`,

  bookclub: `The episode covers, in this order:
  1. Hook: what KIND of book is this? Establish the genre and the vibe in one or two exchanges.
  2. The most exciting, dramatic, terrifying, or heartbreaking moments. Specific scenes — no vague praise.
  3. Characters: who did you love, who did you hate, who surprised you, who disappointed you?
  4. The emotional experience: what does it FEEL like to read this book? Does the ending deliver?
  5. The verdict: who specifically should read this, and what other books is it like?

The hosts express genuine reactions — excitement, surprise, laughter, shock. But only with actual scenes and characters from the manuscript. No invented material.`,
};

const STYLE_RULES = `
HOUSE STYLE:
- Never use em dashes (—). Use periods, commas, colons, or short sentences.
- Never use "I think", "in my opinion", "great job, but", "compelling start", "shows potential", "with some polish".
- State problems directly. State strengths directly when they are genuinely strong.
- No author-aside meta commentary. The hosts are talking to each other, not to the author.
`.trim();

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { pdfBase64, tone, focus, generate_audio, mode } = body;
  if (!pdfBase64) return json(400, { error: 'Missing pdfBase64' });
  const toneKey = TONE_BRIEFS[tone] ? tone : 'casual';
  const modeKey = EPISODE_STRUCTURE[mode] ? mode : 'bookclub';

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) return json(500, { error: 'Server not configured' });
  if (generate_audio && !ELEVEN_KEY) return json(500, { error: 'Audio rendering not configured (ELEVENLABS_API_KEY missing)' });
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  // Credit check
  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits').select('balance').eq('user_id', userId).single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < COST) return json(402, { error: 'Insufficient credits', needed: COST, have: balance });

  // Parse PDF
  let text;
  try {
    const buf = Buffer.from(pdfBase64, 'base64');
    const parsed = await pdfParse(buf);
    text = (parsed.text || '').trim();
  } catch (e) {
    return json(400, { error: 'PDF parse failed: ' + (e.message || String(e)) });
  }
  if (!text) return json(400, { error: 'PDF contained no extractable text' });

  const truncated = text.length > TEXT_CAP;
  const useText = truncated ? text.slice(0, TEXT_CAP) : text;

  // ── Step 1: generate transcript ────────────────────────────────────────────
  let transcript;
  try {
    transcript = await generateTranscript({
      anthropicKey: ANTHROPIC_KEY,
      text: useText,
      tone: toneKey,
      mode: modeKey,
      focus: focus || '',
    });
  } catch (e) {
    return json(502, { error: 'Transcript generation failed: ' + (e.message || String(e)) });
  }

  // ── Step 2: render audio (optional) ────────────────────────────────────────
  let audio_url = null;
  if (generate_audio) {
    try {
      audio_url = await renderAudio({
        elevenKey: ELEVEN_KEY,
        supabase,
        userId,
        lines: transcript.lines,
      });
    } catch (e) {
      // Don't fail the whole run; return transcript with audio_error
      console.error('[podcast-reviewer] audio render failed', e);
      const newBalance = balance - COST;
      await supabase.from('gp_credits').update({ balance: newBalance }).eq('user_id', userId);
      return json(200, {
        title: transcript.title,
        lines: transcript.lines,
        transcript_md: transcript.markdown,
        audio_url: null,
        audio_error: e.message || String(e),
        truncated,
        credits_remaining: newBalance,
      });
    }
  }

  // Deduct credits
  const newBalance = balance - COST;
  await supabase.from('gp_credits').update({ balance: newBalance }).eq('user_id', userId);

  return json(200, {
    title: transcript.title,
    lines: transcript.lines,
    transcript_md: transcript.markdown,
    audio_url,
    truncated,
    credits_remaining: newBalance,
  });
};

// ─── Transcript generation ───────────────────────────────────────────────────
async function generateTranscript({ anthropicKey, text, tone, mode, focus }) {
  const focusLine = focus ? `\nFOCUS: the hosts should center on ${focus}.` : '';
  const modeKey = EPISODE_STRUCTURE[mode] ? mode : 'bookclub';

  const system = `You are scripting a two-host book podcast discussing a fiction manuscript. Output a structured JSON transcript with two speakers labeled A (${HOST_VOICES.A.name}) and B (${HOST_VOICES.B.name}).

TONE: ${TONE_BRIEFS[tone]}

${EPISODE_STRUCTURE[modeKey]}

Length target: 16 to 22 lines total across both hosts. Each line is one to three sentences. Hosts trade off; do not let one monologue. Use the manuscript's actual scenes and characters; do not invent material.

${STYLE_RULES}${focusLine}

OUTPUT FORMAT — return a single JSON object, no preamble, no markdown fences:
{
  "title": "Short episode title, no subtitle",
  "lines": [
    { "speaker": "A", "text": "..." },
    { "speaker": "B", "text": "..." }
  ]
}`;

  const user = `MANUSCRIPT TEXT:
---
${text}
---

Return the JSON object now.`;

  const client = new Anthropic({ apiKey: anthropicKey });
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2200,
    temperature: 0.6,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const rawText = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = rawText.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in response');
  const parsed = JSON.parse(m[0]);

  const lines = (parsed.lines || []).filter((l) => l && l.speaker && l.text);
  const markdown = `# ${parsed.title || 'Podcast Review'}\n\n` +
    lines.map((l) => `**${l.speaker === 'A' ? HOST_VOICES.A.name : HOST_VOICES.B.name}:** ${l.text}`).join('\n\n');

  return { title: parsed.title || 'Podcast Review', lines, markdown };
}

// ─── Audio rendering via ElevenLabs ──────────────────────────────────────────
async function renderAudio({ elevenKey, supabase, userId, lines }) {
  // Render all lines in parallel — sequential was causing function timeouts.
  // MP3 frames are concatenation-safe so order is preserved via Promise.all.
  const buffers = await Promise.all(
    lines.map((line) => {
      const voice = line.speaker === 'A' ? HOST_VOICES.A.voice_id : HOST_VOICES.B.voice_id;
      return ttsRender(elevenKey, voice, line.text);
    })
  );
  const combined = Buffer.concat(buffers);

  // Upload to Supabase Storage
  const filename = `${userId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`;
  const { error: upErr } = await supabase.storage
    .from('playground-audio')
    .upload(filename, combined, { contentType: 'audio/mpeg', upsert: false });
  if (upErr) throw new Error('Storage upload failed: ' + upErr.message);

  const { data: pub } = supabase.storage.from('playground-audio').getPublicUrl(filename);
  return pub?.publicUrl || null;
}

async function ttsRender(elevenKey, voiceId, text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': elevenKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${errText.slice(0, 200)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
