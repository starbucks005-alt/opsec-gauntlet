/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Jules, the Rewrite Partner
   Three modes:
     plan     →  produces a 3-bullet game plan ( 2 credits )
     rewrite  →  rewrites the chapter against an approved plan ( 6 credits )
     iterate  →  reworks an existing rewrite given a user note ( 4 credits )

   Auth     : Bearer (Supabase)
   Response : mode-specific JSON + credits_remaining
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const INPUT_CAP = 15000;
const REWRITE_CAP = 20000;
const PARA_CAP = 4000;
const COST = { plan: 2, rewrite: 6, iterate: 4, 'regenerate-paragraph': 1 };

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const PROBLEM_GUIDANCE = {
  flat:          "The chapter feels flat. The scene doesn't land. Pump emotional stakes, tactile detail, and specificity. Make it land.",
  'pacing-fast': "It moves too fast. Slow down beats that should breathe. Linger on the moments that matter, cut the connective tissue if needed.",
  'pacing-slow': "It drags. The reader would skim. Compress, cut throat-clearing, trust the reader to fill in beats.",
  dialogue:      "Characters don't sound like real people. Differentiate voices. Cut explanatory dialogue. Show through subtext and rhythm, not declaration.",
  prose:         "The bones are right, the words are wrong. Same beats, sharper prose. Replace weak verbs. Cut adverbs. Tighten sentence-by-sentence.",
  screenplay:    "It still reads like a screenplay. Move from external action and dialogue to novel-shaped prose: interiority, sensory grounding, free indirect style, scene transitions.",
  jargon:        "Too much procedural / technical jargon. Trim it. Where jargon stays, ground it through character reaction so the reader feels it instead of decoding it.",
  interiority:   "Add what the POV character is thinking and feeling. Layer in interior reaction without telling the reader how to feel."
};

function problemBlock(problems) {
  if (!problems || !problems.length) return '';
  const lines = problems.map((p) => `- ${PROBLEM_GUIDANCE[p] || p}`);
  return `\n\nAUTHOR'S CONCERNS:\n${lines.join('\n')}`;
}

const HARD_RULES = `HARD RULES (apply to EVERYTHING you write — plan bullets, prose, dialogue, all of it):
- Never use em dashes (—) or en dashes (–). Use periods, commas, colons, semicolons, or short sentences.
- Never use AI-tell vocabulary: "leverage", "delve", "pillar", "robust", "seamless", "navigate" (as a verb meaning manage), "tapestry", "intricate", "underscore", "underpin", "in the realm of", "it is important to note".
- Do not hedge ("perhaps", "might consider"). Be specific and direct.
- Do not apologize, do not preamble, do not narrate your process.
- Preserve the author's voice. You are not replacing the author. You are working underneath what they wrote, sharpening it.`;

/* ─── Mode prompts ──────────────────────────────────────────────────────────── */

function buildPlanPrompts({ chapterText, chapterTitle, genre, problems, freeText, previousPlan, redirect }) {
  const system = `You are Jules, a rewrite partner at Greylander Press. You sit next to the author in plain clothes, the way a smart friend who happens to be a working editor would. You don't pick from a toolbox; you read what's in front of you and propose a short game plan, then wait for the author to sign off before doing anything to the prose.

${HARD_RULES}

Your job in this mode is ONLY the game plan. You do NOT rewrite. You return exactly three bullets describing what you would change and why. Each bullet is one short paragraph (one to three sentences). Each bullet is specific to THIS chapter. No generic craft advice.

Return ONLY a JSON object with this exact shape — no markdown fence, no preamble:
{
  "plan": [
    "First change, one short paragraph specific to this chapter and the author's concerns.",
    "Second change, one short paragraph specific to this chapter and the author's concerns.",
    "Third change, one short paragraph specific to this chapter and the author's concerns."
  ]
}`;

  const titleLine = chapterTitle ? `\nCHAPTER: ${chapterTitle}` : '';
  const genreLine = genre ? `\nGENRE: ${genre}` : '';
  const free = freeText ? `\n\nAUTHOR FREE NOTE:\n${freeText}` : '';
  const redirectBlock = previousPlan && redirect
    ? `\n\nYOU ALREADY DRAFTED THIS PLAN:\n${previousPlan.map((b,i) => `${i+1}. ${b}`).join('\n')}\n\nAUTHOR REDIRECT: ${redirect}\n\nDraft a NEW three-bullet plan that responds to the redirect. Keep what the author still endorsed, change what they pushed back on.`
    : '';

  const user = `${titleLine}${genreLine}${problemBlock(problems)}${free}${redirectBlock}

CHAPTER:
---
${chapterText}
---

Draft your three-bullet game plan for this chapter.`;

  return { system, user };
}

function buildRewritePrompts({ chapterText, chapterTitle, genre, plan }) {
  const system = `You are Jules, a rewrite partner at Greylander Press. You have a signed-off three-bullet game plan from the author. Your job now is to rewrite the chapter against that plan.

${HARD_RULES}

REWRITE RULES:
- Execute every bullet of the plan. Do not skip one.
- Do not add scenes that were not in the original chapter. Do not cut scenes that were in the original chapter. Same beats, sharpened.
- Preserve every named entity exactly: character names, place names, codenames, technical terms (e.g. "Red Earth", "Digital Ghost", "Iron Man", "PUF"). Names are author canon.
- Preserve POV and tense.
- Maintain or slightly tighten length. Do not pad. Do not bloat.
- Keep dialogue lines that already work; rewrite dialogue lines that the plan flagged.
- Do not insert section headers, chapter labels, or scene break dividers that were not in the original.

Return ONLY a JSON object with this exact shape — no markdown fence, no preamble:
{
  "rewrite": "The full rewritten chapter as a single string. Paragraphs separated by a blank line."
}`;

  const titleLine = chapterTitle ? `\nCHAPTER: ${chapterTitle}` : '';
  const genreLine = genre ? `\nGENRE: ${genre}` : '';
  const planBlock = (plan || []).map((b,i) => `${i+1}. ${b}`).join('\n');

  const user = `${titleLine}${genreLine}

SIGNED-OFF PLAN:
${planBlock}

ORIGINAL CHAPTER:
---
${chapterText}
---

Rewrite the chapter against the signed-off plan.`;

  return { system, user };
}

function buildRegenParagraphPrompts({ chapterText, chapterTitle, genre, currentRewrite, paragraph, note }) {
  const system = `You are Jules, a rewrite partner at Greylander Press. The author has approved most of your rewrite but wants you to rework ONE specific paragraph. Your job is to return a replacement for that single paragraph, in voice, in context.

${HARD_RULES}

PARAGRAPH REGENERATION RULES:
- Return ONLY the replacement paragraph. No preamble, no commentary, no quotes around it.
- Match the surrounding paragraphs' voice, POV, tense, and rhythm. Read the current rewrite to understand context.
- The original chapter is supplied as canon. Do not invent new entities. Preserve every name exactly as the author uses it.
- If the author gave a note, follow it. If they gave no note, sharpen the paragraph: cut the weakest sentence, replace one weak verb, tighten rhythm. Same beats, sharper prose.
- Length: roughly the same length as the paragraph you are replacing. Do not balloon. Do not gut.

Return ONLY a JSON object with this exact shape — no markdown fence, no preamble:
{
  "paragraph": "The single replacement paragraph as a string. No quotes wrapping. No leading or trailing whitespace."
}`;

  const titleLine = chapterTitle ? `\nCHAPTER: ${chapterTitle}` : '';
  const genreLine = genre ? `\nGENRE: ${genre}` : '';
  const noteBlock = note ? `\n\nAUTHOR'S NOTE FOR THIS PARAGRAPH:\n${note}` : '\n\nNo specific note. Sharpen the paragraph in line with the rest of the rewrite.';

  const user = `${titleLine}${genreLine}${noteBlock}

ORIGINAL CHAPTER (canon reference — for names, beats, intent):
---
${chapterText}
---

CURRENT REWRITE (context — match this voice):
---
${currentRewrite}
---

PARAGRAPH TO REWRITE (return a replacement for this one paragraph only):
---
${paragraph}
---

Return the replacement paragraph.`;

  return { system, user };
}

function buildIteratePrompts({ chapterText, chapterTitle, genre, currentRewrite, note }) {
  const system = `You are Jules, a rewrite partner at Greylander Press. You have already produced a rewrite of this chapter. The author is now giving you a short note: more of this, less of that. Your job is to rework the rewrite (not the original) against the author's note.

${HARD_RULES}

ITERATION RULES:
- Operate on the CURRENT REWRITE, not the original. The original is provided only as canon reference for names, beats, and intent.
- Push on what the author asked for more of. Pull back on what they asked for less of. Leave the rest alone.
- Do not add new scenes. Do not cut scenes.
- Preserve every named entity exactly.

Return ONLY a JSON object with this exact shape — no markdown fence, no preamble:
{
  "rewrite": "The full reworked chapter as a single string."
}`;

  const titleLine = chapterTitle ? `\nCHAPTER: ${chapterTitle}` : '';
  const genreLine = genre ? `\nGENRE: ${genre}` : '';

  const user = `${titleLine}${genreLine}

AUTHOR'S NOTE FOR THIS PASS:
${note}

ORIGINAL CHAPTER (reference only — for names, beats, canon):
---
${chapterText}
---

CURRENT REWRITE (this is what you rework):
---
${currentRewrite}
---

Rework the current rewrite against the author's note.`;

  return { system, user };
}

/* ─── Handler ───────────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const mode = body.mode;
  if (!['plan', 'rewrite', 'iterate', 'regenerate-paragraph'].includes(mode)) {
    return json(400, { error: "Invalid mode. Must be 'plan', 'rewrite', 'iterate', or 'regenerate-paragraph'." });
  }

  const { chapterText, chapterTitle, genre, problems, freeText, plan, currentRewrite, note, previousPlan, redirect, paragraph } = body;

  if (!chapterText || typeof chapterText !== 'string') return json(400, { error: 'Missing chapter text' });
  if (chapterText.length > INPUT_CAP) return json(413, { error: `Chapter too long. Max ${INPUT_CAP} chars; received ${chapterText.length}.` });

  if (mode === 'rewrite' && (!Array.isArray(plan) || plan.length < 1)) {
    return json(400, { error: 'Rewrite mode requires a signed-off plan (array of bullets).' });
  }
  if (mode === 'iterate') {
    if (!note || typeof note !== 'string') return json(400, { error: 'Iterate mode requires a note.' });
    if (!currentRewrite || typeof currentRewrite !== 'string') return json(400, { error: 'Iterate mode requires currentRewrite.' });
    if (currentRewrite.length > REWRITE_CAP) return json(413, { error: 'Current rewrite too long for iteration pass.' });
  }
  if (mode === 'regenerate-paragraph') {
    if (!paragraph || typeof paragraph !== 'string') return json(400, { error: 'regenerate-paragraph requires paragraph text.' });
    if (paragraph.length > PARA_CAP) return json(413, { error: 'Paragraph too long.' });
    if (!currentRewrite || typeof currentRewrite !== 'string') return json(400, { error: 'regenerate-paragraph requires currentRewrite context.' });
    if (currentRewrite.length > REWRITE_CAP) return json(413, { error: 'Current rewrite too long.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) return json(500, { error: 'Server not configured' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  const cost = COST[mode];

  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits').select('balance').eq('user_id', userId).single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < cost) return json(402, { error: 'Insufficient credits', needed: cost, have: balance });

  let prompts;
  if (mode === 'plan') {
    prompts = buildPlanPrompts({ chapterText, chapterTitle, genre, problems, freeText, previousPlan, redirect });
  } else if (mode === 'rewrite') {
    prompts = buildRewritePrompts({ chapterText, chapterTitle, genre, plan });
  } else if (mode === 'iterate') {
    prompts = buildIteratePrompts({ chapterText, chapterTitle, genre, currentRewrite, note });
  } else {
    prompts = buildRegenParagraphPrompts({ chapterText, chapterTitle, genre, currentRewrite, paragraph, note });
  }

  const maxTokens = mode === 'plan' ? 800 : (mode === 'regenerate-paragraph' ? 1200 : 6000);
  const temperature = mode === 'plan' ? 0.6 : 0.7;

  let parsed;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system: prompts.system,
      messages: [{ role: 'user', content: prompts.user }],
    });
    const raw = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('[jules]', mode, 'AI error', err);
    return json(502, { error: err?.message || 'AI provider error' });
  }

  // Validate response shape per mode
  if (mode === 'plan') {
    if (!Array.isArray(parsed.plan) || parsed.plan.length < 1) {
      return json(502, { error: 'Plan response malformed.' });
    }
    parsed.plan = parsed.plan.slice(0, 3).map((b) => String(b).trim()).filter(Boolean);
  } else if (mode === 'regenerate-paragraph') {
    if (!parsed.paragraph || typeof parsed.paragraph !== 'string') {
      return json(502, { error: 'Paragraph response malformed.' });
    }
    parsed.paragraph = parsed.paragraph.trim();
  } else {
    if (!parsed.rewrite || typeof parsed.rewrite !== 'string') {
      return json(502, { error: 'Rewrite response malformed.' });
    }
    parsed.rewrite = parsed.rewrite.trim();
  }

  const newBalance = balance - cost;
  const { error: updErr } = await supabase
    .from('gp_credits').update({ balance: newBalance }).eq('user_id', userId);
  if (updErr) return json(500, { error: 'Could not deduct credits' });

  return json(200, { ...parsed, credits_remaining: newBalance });
};
