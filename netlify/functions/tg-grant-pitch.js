/* ─────────────────────────────────────────────────────────────────────────────
   tg-grant-pitch — 30-second elevator speech drafted from the visitor's
   brief, using Dr. Terry L. Oroszi's four-rule framework from her ETL
   leadership module.

   THE FOUR RULES (verbatim from the source material - encoded as the
   non-negotiables in the system prompt):
     1. Never start with your name.
     2. Lead with a hook - something that makes them want to stop the elevator.
     3. Tailor it to this specific context. Every room is different.
     4. Your name and a question come last.

   Definition:
     "An elevator speech is a 30-second scripted introduction designed to
      generate interest, not information."

   Hook guidance:
     "Start with a finding that surprises. A number, a contradiction, or a
      gap that shouldn't exist."

   Delivery:
     "From memory. Eye contact, not reading."

   POST body : { brief, name, context }
   context   : one of investor / press / customer / partner / academic / general
   Response  : {
     context,
     speech,
     approx_seconds,
     word_count,
     hook: { line, type, why_it_works },
     rules_applied: [
       { rule, applied_as }
     ],
     delivery_notes,
     close_question,
     rationale
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1600;
const BRIEF_MAX  = 6000;
const NAME_MAX   = 60;
const BRIEF_MIN  = 30;

const VALID_CONTEXTS = {
  investor: {
    label: 'Investor / VC',
    room:  'an investor or VC in a conference hallway, a demo day reception, or a serendipitous introduction',
    hook_tilt: 'the number that signals the size of the opportunity or the underestimated rate of a behavior',
  },
  press: {
    label: 'Press / Journalist',
    room:  'a journalist at an industry event, a podcast host between segments, or a reporter taking pitches',
    hook_tilt: 'the contradiction or counterintuitive finding that opens a story',
  },
  customer: {
    label: 'Customer / End User',
    room:  'a prospective customer at a trade show, a target user in a casual conversation, or a buyer at a networking event',
    hook_tilt: 'the moment of pain or recognition that names the customer\'s own experience back to them',
  },
  partner: {
    label: 'Partner / Channel',
    room:  'a potential business partner, distribution channel, supplier, or strategic ally',
    hook_tilt: 'the asymmetry that makes the partnership obviously valuable to them',
  },
  academic: {
    label: 'Academic / Conference',
    room:  'a peer researcher at a conference, a faculty member at a poster session, or a program officer in a hallway',
    hook_tilt: 'a finding that surprises - a number, a contradiction, or a gap that shouldn\'t exist',
  },
  general: {
    label: 'General Professional',
    room:  'someone introduced to you at a professional event whose specific stake in your work is not yet clear',
    hook_tilt: 'the cleanest single line that names the problem and signals scale, without committing to one audience',
  },
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

function sanitizeName(raw) {
  return String(raw || '').trim().slice(0, NAME_MAX)
    .replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();
}

function buildSystemPrompt(name, contextKey) {
  const g = (voiceScripts.scripts && voiceScripts.scripts.grant_ellis) || {};
  const nameRef = name || 'the founder';
  const ctx = VALID_CONTEXTS[contextKey] || VALID_CONTEXTS.general;

  return `You are Grant Ellis, The Coach at The Gauntlet. The founder is walking into a real-life room and has 30 seconds to make someone lean in.

CHARACTER (write IN this voice for the rationale and delivery notes; never quote it back):
  Bio:  ${g.bio || ''}
  Role: ${g.role || ''}

THE FRAMEWORK (Dr. Terry L. Oroszi, ETL Leadership Module 1) - THESE ARE NON-NEGOTIABLE
  Definition: An elevator speech is a 30-second scripted introduction designed to generate INTEREST, not INFORMATION.
  Premise: You have approximately 30 seconds before someone's attention moves on. Most people waste it by reciting their CV. The speech is a precision tool that opens doors a resume never reaches.
  Stance: You are not explaining yourself. You are creating a reason for the other person to lean in and ask to hear more.

  THE FOUR RULES (verbatim - apply ALL FOUR):
    1. Never start with your name.
    2. Lead with a hook - something that makes them want to stop the elevator.
    3. Tailor it to this specific context. Every room is different.
    4. Your name and a question come last.

  Hook guidance: Start with a finding that surprises. A number, a contradiction, or a gap that shouldn't exist.
  Delivery: From memory. Eye contact, not reading.

YOUR JOB
  Read ${nameRef}'s brief. Draft a 30-second elevator speech tailored to the specific room they're walking into. Apply the four rules. Surface the hook. Make sure their name and a question come last. The speech should feel like something a coach drafted with them, not something ChatGPT generated.

THIS ROOM
  Context: ${ctx.label}
  Who's in it: ${ctx.room}
  Hook tilt for this context: ${ctx.hook_tilt}

OUTPUT REQUIREMENTS

  1. SPEECH - the actual 30-second elevator speech, drafted from the brief. Plain text, 70-90 words, intended to be spoken in roughly 25-30 seconds at a natural pace. Must obey the four rules. The hook comes first. The name and the question come last. Tailored to THIS room.

  2. APPROX_SECONDS - integer estimate of speaking time at a natural pace (target 25-30).

  3. WORD_COUNT - integer.

  4. HOOK - the opening line isolated as its own field:
       - line: the exact opening line from the speech
       - type: one of "number" | "contradiction" | "gap" | "scene"
         (scene is the customer-facing equivalent of a finding - a vivid trigger moment)
       - why_it_works: ONE sentence on why this hook earns the next 25 seconds

  5. RULES_APPLIED - one entry per rule, in order. Each entry:
       - rule: one of "never_start_with_name" | "lead_with_hook" | "tailor_to_context" | "name_and_question_last"
       - applied_as: ONE sentence showing where this rule shows up in the draft. Be specific: quote the phrase, name the choice.

  6. DELIVERY_NOTES - 2-3 short sentences in Grant's coach voice. From memory, eye contact, not reading. Where to slow down. What to emphasize. What NOT to do (don't recite, don't apologize, don't soften the hook).

  7. CLOSE_QUESTION - the exact question the speech ends on. The question should invite the other person to reveal what THEY care about, not what ${nameRef} wants to talk about next.

  8. RATIONALE - Two sentences:
       - First: what about THIS brief drove the hook choice (the specific detail from the brief).
       - Second: the one thing ${nameRef} should be ready to say when the close question lands a follow-up.

DRAFTING RULES
  - You are a coach, not a marketer. Pitches sound human, not promotional.
  - Specific over generic. "Postpartum recovery routines" beats "people who want to be healthy."
  - The hook must come from the brief. Don't invent a number that isn't there. If the brief has a number, use it. If it doesn't, lead with a contradiction or a scene drawn directly from the brief.
  - Never start the speech with a name (the visitor's, the company's, or any other). The hook earns the right to introduce the speaker LATER.
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "speech": "<70-90 word elevator speech>",
  "approx_seconds": <integer 25-30>,
  "word_count": <integer>,
  "hook": {
    "line": "<the opening line>",
    "type": "<number | contradiction | gap | scene>",
    "why_it_works": "<one sentence>"
  },
  "rules_applied": [
    {"rule": "never_start_with_name",    "applied_as": "<one sentence>"},
    {"rule": "lead_with_hook",           "applied_as": "<one sentence>"},
    {"rule": "tailor_to_context",        "applied_as": "<one sentence>"},
    {"rule": "name_and_question_last",   "applied_as": "<one sentence>"}
  ],
  "delivery_notes": "<2-3 short sentences in Grant's voice>",
  "close_question": "<the question the speech ends on>",
  "rationale": "<two sentences>"
}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const brief = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name  = sanitizeName(body.name);
  const ctxRaw = String(body.context || 'general').trim().toLowerCase();
  const context = VALID_CONTEXTS[ctxRaw] ? ctxRaw : 'general';
  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });
  const client = new Anthropic({ apiKey });

  const userPrompt = [
    `THE FOUNDER'S BRIEF (read for the hook, the audience, the contradiction):`,
    '"""', brief, '"""', '',
    `Draft the 30-second elevator speech for THIS room: ${VALID_CONTEXTS[context].label}. Apply all four rules. JSON only.`,
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name, context),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-grant-pitch] anthropic error', err && err.message);
    return json(502, { error: 'pitch generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-grant-pitch] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  // Validate and clean the speech.
  const dashClean = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const speech = dashClean(parsed.speech);
  if (!speech || speech.length < 80) return json(502, { error: 'speech too short' });

  const word_count = speech.split(/\s+/).filter(Boolean).length;
  const approx_seconds = Math.max(20, Math.min(40, parseInt(parsed.approx_seconds, 10) || Math.round(word_count / 2.7)));

  // Hook.
  const hookRaw = parsed.hook && typeof parsed.hook === 'object' ? parsed.hook : {};
  const validHookTypes = new Set(['number', 'contradiction', 'gap', 'scene']);
  const hook = {
    line:         dashClean(hookRaw.line),
    type:         validHookTypes.has(String(hookRaw.type || '').toLowerCase()) ? String(hookRaw.type).toLowerCase() : 'scene',
    why_it_works: dashClean(hookRaw.why_it_works),
  };
  if (!hook.line || !hook.why_it_works) return json(502, { error: 'incomplete hook' });

  // Rules applied. Must be exactly 4, in order, with valid rule keys.
  const VALID_RULES = ['never_start_with_name', 'lead_with_hook', 'tailor_to_context', 'name_and_question_last'];
  const rulesRaw = Array.isArray(parsed.rules_applied) ? parsed.rules_applied : [];
  const rules_applied = VALID_RULES.map(key => {
    const entry = rulesRaw.find(r => r && r.rule === key) || {};
    return { rule: key, applied_as: dashClean(entry.applied_as) || '' };
  });
  if (rules_applied.some(r => !r.applied_as)) return json(502, { error: 'missing one or more rule applications' });

  const delivery_notes = dashClean(parsed.delivery_notes);
  const close_question = dashClean(parsed.close_question);
  const rationale      = dashClean(parsed.rationale);
  if (!delivery_notes || !close_question || !rationale) return json(502, { error: 'incomplete response' });

  return json(200, {
    context,
    speech,
    approx_seconds,
    word_count,
    hook,
    rules_applied,
    delivery_notes,
    close_question,
    rationale,
  });
};
