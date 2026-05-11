/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Jaque, the Query Coach
   Polish query letters, log lines, synopses, comp titles. Sells what you wrote.

   POST body : {
     mode: 'polish_query' | 'log_line' | 'tighten_synopsis' | 'comp_titles',
     payload: {
       // polish_query:     { letter, genre, comps?, wordCount? }
       // log_line:         { pitch, genre }
       // tighten_synopsis: { synopsis, target_words }
       // comp_titles:      { pitch, genre }
     }
   }
   Auth      : Bearer
   Cost      : 2 credits per pass
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const COST  = 2;
const TEXT_CAP = 6000;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const STYLE_RULES = `HOUSE STYLE RULES:
- Never use em dashes (—). Use periods, commas, colons, or short sentences.
- Do not hedge ("I think", "in my opinion").
- Do not cushion. Direct, confident, useful.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { mode, payload = {} } = body;
  const validModes = ['polish_query', 'log_line', 'tighten_synopsis', 'comp_titles'];
  if (!validModes.includes(mode)) return json(400, { error: 'Invalid mode' });

  // Validate primary input
  const primaryByMode = {
    polish_query:     payload.letter,
    log_line:         payload.pitch,
    tighten_synopsis: payload.synopsis,
    comp_titles:      payload.pitch,
  };
  const primary = primaryByMode[mode];
  if (!primary || typeof primary !== 'string') return json(400, { error: 'Missing primary text' });
  if (primary.length > TEXT_CAP) return json(413, { error: `Text too long. Max ${TEXT_CAP} chars.` });

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

  const baseSystem = `You are Jaque, the query coach at Greylander Press. You came up through screenwriting and crossed over to publishing. You know what hooks an agent in 30 seconds and what makes them put a query down. Your taste is sharp, your read is fast.

YOUR JOB: sell what the author wrote. Tighten hooks. Cut throat-clearing. Surface stakes. Find the one sentence that earns the read.

${STYLE_RULES}

Return ONLY a JSON object — no markdown fence, no preamble. Schema in the user prompt.`;

  let userPrompt;
  if (mode === 'polish_query') {
    const genreLine = payload.genre ? `\nGENRE: ${payload.genre}` : '';
    const compsLine = payload.comps ? `\nCOMP TITLES: ${payload.comps}` : '';
    const wcLine    = payload.wordCount ? `\nWORD COUNT: ${payload.wordCount}` : '';
    userPrompt = `MODE: POLISH QUERY LETTER${genreLine}${compsLine}${wcLine}

ORIGINAL QUERY:
---
${payload.letter}
---

Rewrite the query letter for an agent submission. Keep the author's voice and the book's actual content; sharpen the prose, tighten the hook, surface the stakes, and remove throat-clearing. Standard query letter structure: hook paragraph, book paragraph, bio paragraph, closing.

Return JSON:
{
  "polished":          "the full rewritten query letter, paragraphs separated by blank lines",
  "hook_assessment":   "1-2 sentences on whether the hook actually hooks. Direct.",
  "stakes_assessment": "1-2 sentences on whether the stakes land. Direct.",
  "change_log":        ["4-8 bullet lines describing the most significant changes"],
  "warnings":          "1-2 sentences flagging anything still weak, or empty string if it's solid"
}`;
  } else if (mode === 'log_line') {
    const genreLine = payload.genre ? `\nGENRE: ${payload.genre}` : '';
    userPrompt = `MODE: LOG LINE${genreLine}

PITCH:
---
${payload.pitch}
---

Generate a single-sentence log line in the conventions of the genre. Include: protagonist + identifier, inciting event, central conflict, what's at stake. Plus 3 alternates that try different angles (character-first / situation-first / theme-first).

Return JSON:
{
  "log_line":   "the strongest single sentence",
  "alternates": ["alternate 1", "alternate 2", "alternate 3"],
  "notes":      "1-2 sentences on the choices you made and what's emphasized"
}`;
  } else if (mode === 'tighten_synopsis') {
    const targetLine = payload.target_words ? `\nTARGET LENGTH: about ${payload.target_words} words` : '\nTARGET LENGTH: tighten by roughly 30%';
    userPrompt = `MODE: TIGHTEN SYNOPSIS${targetLine}

ORIGINAL SYNOPSIS:
---
${payload.synopsis}
---

Tighten the synopsis. Preserve every plot turn, every named character, the ending, and the emotional arc. Cut wordiness, redundancy, throat-clearing, and minor digressions. Keep present tense and active voice.

Return JSON:
{
  "tightened":   "the rewritten synopsis",
  "word_count":  estimated word count (integer),
  "what_was_cut":"2-3 sentences listing the categories of cuts (e.g., 'minor side plot at chapter 6, repetitive emotional beats around the middle, three adverbs per page')",
  "warnings":    "anything you couldn't shorten without losing essential information, or empty string"
}`;
  } else if (mode === 'comp_titles') {
    const genreLine = payload.genre ? `\nGENRE: ${payload.genre}` : '';
    userPrompt = `MODE: COMP TITLE SUGGESTIONS${genreLine}

PITCH:
---
${payload.pitch}
---

Suggest 5-7 published comparable titles ("comps") that an agent or editor would recognize and that genuinely match the book's tone, structure, voice, or thematic territory. Avoid: massive bestsellers as solo comps (use them only paired), books over 10 years old (unless the book is a literary classic in its own niche), books in mismatched genres.

Return JSON:
{
  "comps": [
    {
      "title":     "Book Title",
      "author":    "Author Name",
      "year":      "publication year",
      "why_match": "1-2 sentences — what specifically about this book matches the pitch (tone, structure, voice, theme)"
    }
  ],
  "comp_pitch_lines": ["3 example 'X meets Y' style pitch lines using comps from above"],
  "caveat": "1 sentence reminding the author that comp titles change with the market — verify current relevance before submitting."
}

CRITICAL: do not invent books. If you are uncertain a book exists or got the author right, leave it out. Recommend fewer than fabricate.`;
  }

  let parsed;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      temperature: 0.5,
      system: baseSystem,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const raw = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('[jaque] AI error', err);
    return json(502, { error: err?.message || 'AI provider error' });
  }

  const newBalance = balance - COST;
  const { error: updErr } = await supabase
    .from('gp_credits').update({ balance: newBalance }).eq('user_id', userId);
  if (updErr) return json(500, { error: 'Could not deduct credits' });

  return json(200, { mode, result: parsed, credits_remaining: newBalance });
};
