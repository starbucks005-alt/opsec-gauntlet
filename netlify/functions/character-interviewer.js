/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Character Interviewer

   Two modes via the same endpoint:
     mode = 'extract'  Parse a manuscript PDF and return the character list
                       (name, role, Want, Lie, Need, voice cues). FREE.
     mode = 'chat'     Send a question to a specific character; get a reply
                       in that character's voice using their W/L/N as context.
                       Costs 2 credits per question.

   Stateless: chat history is passed by the client each turn. No DB persistence
   for v1. The character list is also returned to the client and re-sent at chat
   time so we don't have to store it server-side.
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const MODEL = 'claude-sonnet-4-6';
const CHAT_COST = 2;
const HISTORY_TURN_CAP = 12;

const STYLE_RULES = `
HOUSE STYLE:
- Never use em dashes (—). Use periods, commas, colons, or short sentences.
- No hedging ("I think", "I believe", "in my opinion").
- No author-aside meta commentary; respond in-character.
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

  const { mode } = body;
  if (mode !== 'extract' && mode !== 'chat') {
    return json(400, { error: "mode must be 'extract' or 'chat'" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server not configured' });
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  if (mode === 'extract') return await handleExtract(body, client);
  if (mode === 'chat')    return await handleChat(body, client, supabase, userId);
};

// ─── Extract characters from a PDF ───────────────────────────────────────────
async function handleExtract(body, client) {
  const { pdfBase64 } = body;
  if (!pdfBase64) return json(400, { error: 'Missing pdfBase64' });

  let text;
  try {
    const buf = Buffer.from(pdfBase64, 'base64');
    const parsed = await pdfParse(buf);
    text = (parsed.text || '').trim();
  } catch (e) {
    return json(400, { error: 'PDF parse failed: ' + (e.message || String(e)) });
  }
  if (!text) return json(400, { error: 'PDF contained no extractable text' });

  // Cap input for extraction
  const TEXT_CAP = 60000;
  const truncated = text.length > TEXT_CAP;
  const useText = truncated ? text.slice(0, TEXT_CAP) : text;

  const system = `You are extracting the principal cast of a fiction manuscript so an interviewer can talk to them in their own voices.

For each principal character (protagonist, antagonist, major supporting roles), return:
  name           — exact name as used in the manuscript
  role           — protagonist / antagonist / ally / mentor / love_interest / other
  want           — the tangible external goal they pursue (one sentence)
  lie            — the false belief or self-deception they carry; this is psychological, not a license to deny facts (one sentence)
  need           — the internal truth they have to accept (one sentence)
  voice          — how they speak: vocabulary, rhythm, default emotional register, what they reach for under pressure, what they avoid. Three to five sentences. Be specific and distinctive.
  summary        — two to three sentences: who they are, what they do in the story, and how their actions drive the plot
  key_events     — a bulleted list (plain text, one line each) of the most important things this character DOES or that HAPPEN TO them in the manuscript. Concrete, factual, no interpretation. Six to ten bullets.

Skip walk-on characters and characters whose role is unclear from the text.

${STYLE_RULES}

OUTPUT FORMAT — return a single JSON object, no preamble, no markdown fences:
{
  "characters": [
    { "name": "...", "role": "...", "want": "...", "lie": "...", "need": "...", "voice": "...", "summary": "...", "key_events": "..." }
  ]
}`;

  const user = `MANUSCRIPT TEXT${truncated ? ' (truncated to first 60,000 chars)' : ''}:
---
${useText}
---

Return the JSON object now.`;

  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (err) {
    return json(502, { error: err?.message || 'AI provider error' });
  }

  const rawText = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let parsed;
  try {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');
    parsed = JSON.parse(m[0]);
  } catch (e) {
    return json(502, { error: 'Could not parse character extraction: ' + e.message, raw: rawText.slice(0, 500) });
  }

  return json(200, { characters: parsed.characters || [], truncated });
}

// ─── Chat with a specific character ──────────────────────────────────────────
async function handleChat(body, client, supabase, userId) {
  const { character, history, question } = body;
  if (!character || !character.name) return json(400, { error: 'Missing character' });
  if (!question || !question.trim())  return json(400, { error: 'Missing question' });

  // Credit check
  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < CHAT_COST) {
    return json(402, { error: 'Insufficient credits', needed: CHAT_COST, have: balance });
  }

  const system = `You are ${character.name}, a character from a fiction manuscript. You are being interviewed by the author. Respond AS the character — in your voice, your worldview, your emotional register. Do not break character.

YOUR PROFILE (the author wrote you this way; honor every detail):
Role:       ${character.role || 'unspecified'}
Summary:    ${character.summary || ''}
Want:       ${character.want || ''}
Lie:        ${character.lie || ''}
Need:       ${character.need || ''}
Voice:      ${character.voice || ''}
Key events: ${character.key_events || ''}

INTERVIEW RULES:
- Your Lie is a psychological self-deception — a belief that distorts how you see yourself and the world. It is NOT a license to deny things you actually did. When the author asks about events listed in your key events, or about actions that happened in the manuscript, acknowledge them. Your Lie is how you RATIONALIZE or MINIMIZE those events, not grounds to claim they never happened.
- Stay in your specific voice at all times. If your voice is snarky, be snarky. If your voice is cold, be cold. Never flatten into a generic neutral tone.
- If the author pushes you toward your Need (the truth you avoid), resist — but through your Lie and your voice, not by inventing a different version of events.
- If the author asks about something genuinely outside the manuscript, say so in your own voice.
- Do not flatter the author. Do not say "great question." If a question reveals a characterization problem, say so in character.
- Brief is better than verbose. One to four sentences for most replies.

${STYLE_RULES}`;

  const trimmed = (Array.isArray(history) ? history : []).slice(-HISTORY_TURN_CAP);
  const messages = [
    ...trimmed
      .filter((m) => m && m.role && m.content)
      .map((m) => ({ role: m.role === 'character' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: question },
  ];

  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      temperature: 0.85,
      system,
      messages,
    });
  } catch (err) {
    return json(502, { error: err?.message || 'AI provider error' });
  }

  const reply = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Deduct credits
  const newBalance = balance - CHAT_COST;
  await supabase.from('gp_credits').update({ balance: newBalance }).eq('user_id', userId);

  return json(200, { reply, credits_remaining: newBalance });
}
