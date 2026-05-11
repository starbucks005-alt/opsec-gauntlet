/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Margo, the Beta Reader
   Reads as a reader. Returns gut reactions, not editorial notes.

   POST body : {
     chapter:      string (required, ≤15000 chars),
     genre:        string (optional — shapes which lens she reads through),
     chapterTitle: string (optional)
   }
   Auth      : Bearer
   Cost      : 5 credits per chapter
   Response  : {
     reaction:        "1 paragraph immediate gut reaction",
     hooked_at:       "where she got hooked / pulled in (with quoted moments)",
     bored_at:        "where her attention drifted / when she skimmed (with quoted moments or empty string)",
     twist_check:     "did the twist or surprise land — saw it coming / didn't / felt manipulated",
     character_connection: "did she connect with the protagonist and why or why not",
     ending_verdict:  "did the ending of this chapter land",
     wish_different:  "the one thing she wishes were different",
     dominant_mood:   "fun" | "sad" | "scary" | "mystery" | "romance",
     credits_remaining: number
   }
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const COST  = 5;
const INPUT_CAP = 15000;

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

  const { chapter, genre, chapterTitle } = body;
  if (!chapter || typeof chapter !== 'string') return json(400, { error: 'Missing chapter text' });
  if (chapter.length > INPUT_CAP) {
    return json(413, { error: `Chapter too long. Max ${INPUT_CAP} chars; received ${chapter.length}.` });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server not configured' });
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits').select('balance').eq('user_id', userId).single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < COST) return json(402, { error: 'Insufficient credits', needed: COST, have: balance });

  const genreLine = genre ? `\nGENRE: ${genre}` : '';
  const titleLine = chapterTitle ? `\nCHAPTER: ${chapterTitle}` : '';

  const system = `You are Margo, a beta reader at Greylander Press. You are NOT an editor, NOT a craft critic, NOT a copy editor. You read as a reader.

Purple hair, plaid flannel, beaded bracelets, snacks within reach. You read at night with a candle and a Coke. You laugh out loud at lines that work, you cry at deaths that earn it, you yell at the page when a character makes a stupid choice. You write your reactions on sticky notes: "OMG plot twist!" "Bored in Ch. 3" "Love the hero!" "Didn't like the ending."

YOUR LENS:
- You react. You don't analyze.
- "I felt" matters. "The author intended" does not.
- If you got bored, you say so. If you got hooked, you say where exactly.
- If the twist worked, name the moment it landed. If you saw it coming, say which clue gave it away.
- Quote actual lines from the chapter when you can. That's how a real beta reader reports.

HARD RULES:
- Never use em dashes (—). Use periods, commas, colons, or short sentences.
- Do not hedge ("I think the author was trying to..."). React. "I loved this" / "I lost interest here" / "this didn't land for me".
- Do not give craft notes ("the pacing is off in act 2"). Give READER reports ("I started skimming after the second time he checked his phone").
- Do not be cruel. Be honest, specific, and warm.

Return ONLY a JSON object — no markdown fence, no preamble. Schema in the user prompt.`;

  const user = `${titleLine}${genreLine}

CHAPTER:
---
${chapter}
---

Read the chapter as a reader. Return your reactions in this exact JSON shape:

{
  "reaction":             "1 paragraph immediate gut reaction. The first thing you'd text the author after finishing.",
  "hooked_at":            "Where you got pulled in. Quote the line or moment if you can. 2-4 sentences.",
  "bored_at":             "Where your attention drifted, where you skimmed, or where you nearly put it down. Quote moments. 2-4 sentences. If you never got bored, say so plainly: 'I never lost interest. I read straight through.'",
  "twist_check":          "Did the twist / surprise / reveal land? Did you see it coming, and if so, what gave it away? 2-3 sentences. If there's no twist in this chapter, say so.",
  "character_connection": "Did you connect with the protagonist (or POV character)? Why or why not? Be specific about a moment that made you trust them or pull away. 2-3 sentences.",
  "ending_verdict":       "Did this chapter's ending land? Did it make you turn the page, or did it deflate? 1-2 sentences.",
  "wish_different":       "The one thing you wish were different. Just one. 1-2 sentences.",
  "dominant_mood":        "fun" | "sad" | "scary" | "mystery" | "romance"
}

For dominant_mood, pick the single mood that best matches your overall reaction to this chapter. Use it even if the genre suggests otherwise — your reaction is what matters.`;

  let parsed;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2500,
      temperature: 0.7,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const raw = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('[margo] AI error', err);
    return json(502, { error: err?.message || 'AI provider error' });
  }

  const newBalance = balance - COST;
  const { error: updErr } = await supabase
    .from('gp_credits').update({ balance: newBalance }).eq('user_id', userId);
  if (updErr) return json(500, { error: 'Could not deduct credits' });

  return json(200, { ...parsed, credits_remaining: newBalance });
};
